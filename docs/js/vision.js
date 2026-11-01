// Visual recognition fallback: your trained YOLOv8n model (25 products),
// exported to ONNX and run on the phone with onnxruntime-web.
//
// IMPORTANT LIMIT: this is a closed-set detector. It only knows the 25
// products in model/labels.json and it will confidently label *other* packs
// as one of them (on your Haldiram's Taka-Tak photo it says "Kolson Slanty
// Jalapeno" at 86%). So a camera guess is never spoken as fact:
//   * if the OCR text is available, the guess must agree with that text;
//   * if there is no readable text, the guess must be stable over 3 frames
//     and is spoken only as a hedged "possible match".

const BASE = new URL("../", import.meta.url);
let session = null, meta = null, ort = null;

async function load() {
  if (session) return;
  ort = await import("../vendor/ort/ort.wasm.min.mjs");
  ort.env.wasm.wasmPaths = new URL("vendor/ort/", BASE).href;
  ort.env.wasm.numThreads = 1;           // threads need cross-origin isolation (not on GitHub Pages)
  meta = await (await fetch(new URL("model/labels.json", BASE))).json();
  session = await ort.InferenceSession.create(new URL("model/grocery.onnx", BASE).href, {
    executionProviders: ["wasm"],
  });
}

export const warmUp = () => load().catch(() => {});
export const names = () => meta?.names || [];

/** Letterbox a canvas to size x size (grey padding), return CHW float tensor data. */
function preprocess(src, size) {
  const r = Math.min(size / src.width, size / src.height);
  const nw = Math.round(src.width * r), nh = Math.round(src.height * r);
  const dx = Math.floor((size - nw) / 2), dy = Math.floor((size - nh) / 2);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "rgb(114,114,114)";
  g.fillRect(0, 0, size, size);
  g.drawImage(src, 0, 0, src.width, src.height, dx, dy, nw, nh);
  const d = g.getImageData(0, 0, size, size).data;
  const n = size * size, out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = d[i * 4] / 255;
    out[n + i] = d[i * 4 + 1] / 255;
    out[2 * n + i] = d[i * 4 + 2] / 255;
  }
  return { data: out, r, dx, dy };
}

function iou(a, b) {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]), y1 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return u > 0 ? inter / u : 0;
}

/** @returns {Promise<{index:number,label:string,conf:number,box:number[]}[]>} best first */
export async function detect(canvas, { conf = 0.25, nms = 0.45 } = {}) {
  await load();
  const size = meta.imgsz || 640;
  const { data, r, dx, dy } = preprocess(canvas, size);
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, size, size]) });
  const t = out[session.outputNames[0]];
  const [, ch, n] = t.dims;               // [1, 4 + classes, anchors]
  const nc = ch - 4, p = t.data;
  const cands = [];
  for (let i = 0; i < n; i++) {
    let best = 0, k = -1;
    for (let c = 0; c < nc; c++) {
      const s = p[(4 + c) * n + i];
      if (s > best) { best = s; k = c; }
    }
    if (best < conf) continue;
    const cx = p[i], cy = p[n + i], w = p[2 * n + i], h = p[3 * n + i];
    cands.push({
      index: k, conf: best,
      box: [(cx - w / 2 - dx) / r, (cy - h / 2 - dy) / r, (cx + w / 2 - dx) / r, (cy + h / 2 - dy) / r],
    });
  }
  cands.sort((a, b) => b.conf - a.conf);
  const keep = [];
  for (const c of cands) {
    if (keep.every((k) => k.index !== c.index || iou(k.box, c.box) < nms)) keep.push(c);
  }
  return keep.map((c) => ({ ...c, label: meta.names[c.index] }));
}

// ---------------------------------------------------------------- cross-check with OCR text
const words = (s) => (s.toLowerCase().match(/[a-z]+/g) || []);
function close(a, b) {                       // equal, or one edit away for longer words
  if (a === b) return true;
  if (a.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, e = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++e > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return e + (a.length - i) + (b.length - j) <= 1;
}

/** True when the OCR text contains the brand/flavour words of class `index`. */
export function agreesWithText(index, text) {
  const seen = words(text);
  return meta.keywords[index].every((group) => group.some((k) => seen.some((w) => close(k, w))));
}

/** Short name for speech: drop the pack size at the end. */
export const speakable = (label) => label.replace(/\s+\d+(\.\d+)?\s*(gm|g|ml|kg|l)$/i, "");
