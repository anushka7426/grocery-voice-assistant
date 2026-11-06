// Turns a picture of a product into a vector of 1280 numbers (an "embedding").
// Two pictures of the same product give vectors that point the same way, so
// "which product is this?" becomes "which saved photo is closest?". A new product
// is added by saving a few photos; nothing has to be retrained.
//
// Model: the ImageNet-trained YOLOv8n classifier without its final layer
// (training/export_embedder.py). The same file is used on the computer
// (training/build_refs.py), so vectors made there match the ones made here.

const BASE = new URL("../model/", import.meta.url);
let session = null, meta = null, ort = null, missing = false;

async function load() {
  if (session) return true;
  if (missing) return false;
  try {
    meta = await (await fetch(new URL("embed.json", BASE))).json();
    ort = await import("../vendor/ort/ort.wasm.min.mjs");
    ort.env.wasm.wasmPaths = new URL("../vendor/ort/", import.meta.url).href;
    ort.env.wasm.numThreads = 1;
    session = await ort.InferenceSession.create(new URL("embed.onnx", BASE).href, { executionProviders: ["wasm"] });
    return true;
  } catch { missing = true; return false; }
}
export const available = () => load();
export const warmUp = () => load().catch(() => false);

const PAD = 0.04;   // keep a little context around a box

/** Crop `box` ([x0,y0,x1,y1]) out of `src`, squash to size x size, return CHW floats 0..1. */
function preprocess(src, box, size) {
  const W = src.width, H = src.height;
  let [x0, y0, x1, y1] = box || [0, 0, W, H];
  const px = (x1 - x0) * PAD, py = (y1 - y0) * PAD;
  x0 = Math.max(0, x0 - px); y0 = Math.max(0, y0 - py); x1 = Math.min(W, x1 + px); y1 = Math.min(H, y1 + py);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high";
  g.drawImage(src, x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0), 0, 0, size, size);
  const d = g.getImageData(0, 0, size, size).data;
  const n = size * size, out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = d[i * 4] / 255;
    out[n + i] = d[i * 4 + 1] / 255;
    out[2 * n + i] = d[i * 4 + 2] / 255;
  }
  return out;
}

/** @returns {Promise<Float32Array|null>} unit-length vector, or null if the model is missing */
export async function embed(src, box = null) {
  if (!(await load())) return null;
  const size = meta.imgsz || 224;
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", preprocess(src, box, size), [1, 3, size, size]) });
  const v = Float32Array.from(out[session.outputNames[0]].data);
  let n = 0; for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// compact storage for bundled reference vectors: int8, base64
export function pack(v) {
  const b = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) b[i] = Math.max(-127, Math.min(127, Math.round(v[i] * 127)));
  let s = ""; for (const x of b) s += String.fromCharCode(x & 255);
  return btoa(s);
}
export function unpack(b64) {
  const s = atob(b64), v = new Float32Array(s.length);
  let n = 0;
  for (let i = 0; i < s.length; i++) { const x = (s.charCodeAt(i) << 24) >> 24; v[i] = x / 127; n += v[i] * v[i]; }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}
