// "Which of MY products is this?" - an image classifier trained on the photos
// taken inside the app (see photos.js and training/train_products.py).
//
// It is optional: until you train a model and copy two files into docs/model/
//   products-cls.onnx   and   products-cls.json
// this module reports "not available" and the app simply skips it.
//
// Safety: the training data includes an "other" class (things that are not one
// of your products). A result is spoken only if it is clearly ahead of the
// runner-up and is not "other".

const BASE = new URL("../model/", import.meta.url);
const MIN_CONF = 0.85;          // top probability needed
const MIN_MARGIN = 0.30;        // lead over the second-best class needed

let session = null, meta = null, ort = null, missing = false;

async function load() {
  if (session) return true;
  if (missing) return false;
  try {
    const r = await fetch(new URL("products-cls.json", BASE));
    if (!r.ok) throw new Error("no model");
    meta = await r.json();
    ort = await import("../vendor/ort/ort.wasm.min.mjs");
    ort.env.wasm.wasmPaths = new URL("../vendor/ort/", import.meta.url).href;
    ort.env.wasm.numThreads = 1;
    session = await ort.InferenceSession.create(new URL("products-cls.onnx", BASE).href, { executionProviders: ["wasm"] });
    return true;
  } catch {
    missing = true;
    return false;
  }
}

export const available = () => load();
export const warmUp = () => load().catch(() => false);

/** Resize the shorter side to `size`, centre-crop to size x size (same as training/validation). */
function preprocess(src, size) {
  const r = size / Math.min(src.width, src.height);
  const w = Math.round(src.width * r), h = Math.round(src.height * r);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high";
  g.drawImage(src, (size - w) / 2, (size - h) / 2, w, h);
  const d = g.getImageData(0, 0, size, size).data;
  const n = size * size, out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {                       // RGB, 0..1, no mean/std (matches ultralytics classify)
    out[i] = d[i * 4] / 255;
    out[n + i] = d[i * 4 + 1] / 255;
    out[2 * n + i] = d[i * 4 + 2] / 255;
  }
  return out;
}

/**
 * @returns {Promise<null | {top:{code:string,conf:number,info:object}, second:number, accepted:boolean}>}
 * `accepted` is true only for a confident, clear, non-"other" answer.
 */
export async function classify(canvas) {
  if (!(await load())) return null;
  const size = meta.imgsz || 224;
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", preprocess(canvas, size), [1, 3, size, size]) });
  const p = out[session.outputNames[0]].data;
  let order = Array.from(p, (v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  // some exports return raw scores instead of probabilities: softmax them
  const sum = p.reduce((a, b) => a + b, 0);
  if (sum < 0.99 || sum > 1.01) {
    const mx = order[0][0], e = Array.from(p, (v) => Math.exp(v - mx)), z = e.reduce((a, b) => a + b, 0);
    order = order.map(([v, i]) => [e[i] / z, i]);
  }
  const [[conf, idx], [second]] = order.length > 1 ? order : [order[0], [0]];
  const code = meta.names[idx];
  return {
    top: { code, conf, info: meta.classes?.[code] || {} },
    second,
    accepted: code !== "other" && conf >= MIN_CONF && conf - second >= MIN_MARGIN,
  };
}
