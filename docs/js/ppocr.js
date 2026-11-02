// On-device text reader: PaddleOCR PP-OCRv4 (text detection + recognition)
// running in the browser with onnxruntime-web. It reads stylised pack
// lettering, brand logos and prices far better than Tesseract.
// (Models: MIT-licensed export from the @gutenye/ocr-models npm package;
//  PaddleOCR is Apache-2.0.)
//
// Pipeline:  frame -> detector (finds text lines) -> recogniser (reads each
// line) -> list of {text, conf, box, h} in reading order.

const BASE = new URL("../model/ocr/", import.meta.url);
const DET_MAX_SIDE = 1280;     // longest side fed to the detector
const THRESH = 0.3;            // probability threshold for the text map
const BOX_SCORE = 0.5;         // minimum mean probability of a detected line
const UNCLIP = 1.6;            // how much to grow the (shrunk) detected regions

let ort = null, det = null, rec = null, chars = null, loading = null;

async function load() {
  if (det && rec && chars) return;
  if (!loading) {
    loading = (async () => {
      ort = await import("../vendor/ort/ort.wasm.min.mjs");
      ort.env.wasm.wasmPaths = new URL("../vendor/ort/", import.meta.url).href;
      ort.env.wasm.numThreads = 1;
      const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
      const keys = (await (await fetch(new URL("keys.txt", BASE))).text()).split(/\r?\n/);
      if (keys[keys.length - 1] === "") keys.pop();
      chars = ["blank", ...keys, " "];                 // CTC index 0 = blank, last = space
      det = await ort.InferenceSession.create(new URL("det.onnx", BASE).href, opts);
      rec = await ort.InferenceSession.create(new URL("rec.onnx", BASE).href, opts);
    })().catch((e) => { loading = null; throw e; });
  }
  await loading;
}

export const warmUp = () => load().catch(() => {});

// ------------------------------------------------------------------ detection
function toTensor(canvas, mean, std) {
  const { width: w, height: h } = canvas;
  const d = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const n = w * h, out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {                        // PaddleOCR feeds BGR
    out[i] = (d[i * 4 + 2] / 255 - mean[0]) / std[0];
    out[n + i] = (d[i * 4 + 1] / 255 - mean[1]) / std[1];
    out[2 * n + i] = (d[i * 4] / 255 - mean[2]) / std[2];
  }
  return out;
}

/** Connected components of the thresholded map -> axis-aligned text boxes. */
function findBoxes(prob, w, h) {
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const boxes = [];
  let next = 0;
  for (let s = 0; s < w * h; s++) {
    if (prob[s] <= THRESH || label[s]) continue;
    next++;
    let sp = 0, count = 0, sum = 0;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack[sp++] = s; label[s] = next;
    while (sp) {
      const p = stack[--sp];
      const x = p % w, y = (p / w) | 0;
      count++; sum += prob[p];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && prob[p - 1] > THRESH && !label[p - 1]) { label[p - 1] = next; stack[sp++] = p - 1; }
      if (x < w - 1 && prob[p + 1] > THRESH && !label[p + 1]) { label[p + 1] = next; stack[sp++] = p + 1; }
      if (y > 0 && prob[p - w] > THRESH && !label[p - w]) { label[p - w] = next; stack[sp++] = p - w; }
      if (y < h - 1 && prob[p + w] > THRESH && !label[p + w]) { label[p + w] = next; stack[sp++] = p + w; }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (Math.min(bw, bh) < 3 || count < 12 || sum / count < BOX_SCORE) continue;
    // grow the shrunk region the way DB post-processing does (distance = area*ratio/perimeter)
    const dist = (bw * bh * UNCLIP) / (2 * (bw + bh));
    boxes.push([x0 - dist, y0 - dist, x1 + 1 + dist, y1 + 1 + dist]);
  }
  return boxes;
}

// ------------------------------------------------------------------ recognition
async function recogniseCrop(src, [x0, y0, x1, y1]) {
  const w = x1 - x0, h = y1 - y0;
  const outH = 48;
  const outW = Math.max(16, Math.min(1600, Math.ceil((outH * w) / h)));
  const c = document.createElement("canvas");
  c.width = outW; c.height = outH;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#fff"; g.fillRect(0, 0, outW, outH);
  g.imageSmoothingQuality = "high";
  g.drawImage(src, x0, y0, w, h, 0, 0, outW, outH);
  const input = toTensor(c, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
  const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, outH, outW]) });
  const t = out[rec.outputNames[0]];
  const [, T, C] = t.dims, p = t.data;
  let text = "", prev = 0, conf = 0, kept = 0;
  for (let i = 0; i < T; i++) {
    let best = 0, bi = 0;
    for (let k = 0; k < C; k++) { const v = p[i * C + k]; if (v > best) { best = v; bi = k; } }
    if (bi !== 0 && bi !== prev) { text += chars[bi] ?? ""; conf += best; kept++; }
    prev = bi;
  }
  return { text: text.trim(), conf: kept ? conf / kept : 0 };
}

/**
 * Read all text in a canvas.
 * @returns {Promise<{text:string, conf:number, box:number[], h:number}[]>} reading order
 */
export async function readText(canvas) {
  await load();
  // detector input: longest side <= DET_MAX_SIDE, both sides multiples of 32
  const s = Math.min(1, DET_MAX_SIDE / Math.max(canvas.width, canvas.height));
  const dw = Math.max(32, Math.round((canvas.width * s) / 32) * 32);
  const dh = Math.max(32, Math.round((canvas.height * s) / 32) * 32);
  const dc = document.createElement("canvas");
  dc.width = dw; dc.height = dh;
  const dg = dc.getContext("2d", { willReadFrequently: true });
  dg.imageSmoothingQuality = "high";
  dg.drawImage(canvas, 0, 0, dw, dh);
  const input = toTensor(dc, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]);
  const out = await det.run({ [det.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, dh, dw]) });
  const prob = out[det.outputNames[0]].data;

  const fx = canvas.width / dw, fy = canvas.height / dh;
  const boxes = findBoxes(prob, dw, dh).map(([a, b, c, d]) => [
    Math.max(0, a * fx), Math.max(0, b * fy), Math.min(canvas.width, c * fx), Math.min(canvas.height, d * fy),
  ]).filter((b) => b[2] - b[0] > 4 && b[3] - b[1] > 4);

  const lines = [];
  for (const box of boxes) {
    const r = await recogniseCrop(canvas, box);
    if (r.text && r.conf >= 0.5) lines.push({ ...r, box, h: box[3] - box[1] });
  }
  // reading order: top to bottom, left to right within a row (same row = vertical overlap > half the smaller line)
  lines.sort((a, b) => {
    const overlap = Math.min(a.box[3], b.box[3]) - Math.max(a.box[1], b.box[1]);
    return overlap > 0.5 * Math.min(a.h, b.h) ? a.box[0] - b.box[0] : a.box[1] - b.box[1];
  });
  return lines;
}
