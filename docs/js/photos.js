// Training photos taken inside the app, and the training-dataset export.
//
// Each photo is stored on the phone with the barcode of the product it shows.
// Export builds a ZIP laid out for training an image classifier:
//   dataset/train/<barcode>/*.jpg
//   dataset/val/<barcode>/*.jpg
//   classes.json   (barcode -> name, brand, size, price, diet)
// Photos of things that are NOT a product go in the "other" class; that class
// is what teaches the model to say "I don't know" instead of guessing.

import * as store from "./store.js";
import { makeZip } from "./zip.js";

export const OTHER = "other";
const MAX_SIDE = 800;          // keep photos small: plenty for a 224 px classifier
const QUALITY = 0.85;

const key = (code, session, n) => `${code}|${session}|${String(n).padStart(3, "0")}`;

function toBlob(canvas) {
  return new Promise((res) => canvas.toBlob(res, "image/jpeg", QUALITY));
}

/** Downscale any image source (canvas, <img>, ImageBitmap) to a JPEG blob. */
async function jpeg(src, w, h) {
  const s = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return toBlob(c);
}

export const newSession = () => Date.now().toString(36);

/** Store one photo from a canvas. */
export async function addPhoto(code, session, n, canvas) {
  const blob = await jpeg(canvas, canvas.width, canvas.height);
  await store.put("photos", key(code, session, n), { code, session, blob });
  return blob.size;
}

/** Store photos picked from the phone's gallery. Returns how many were added. */
export async function addFiles(code, files) {
  const session = newSession();
  let n = 0;
  for (const f of files) {
    try {
      const bmp = await createImageBitmap(f);
      const blob = await jpeg(bmp, bmp.width, bmp.height);
      await store.put("photos", key(code, session, n++), { code, session, blob });
    } catch { /* not an image: skip */ }
  }
  return n;
}

/** Number of photos per class: { code: count } */
export async function counts() {
  const keys = (await store.keys("photos")) || [];
  const out = {};
  for (const k of keys) { const code = String(k).split("|")[0]; out[code] = (out[code] || 0) + 1; }
  return out;
}

export async function deletePhotos(code) {
  const keys = (await store.keys("photos")) || [];
  for (const k of keys) if (String(k).startsWith(code + "|")) await store.del("photos", k);
}

/**
 * Build the training ZIP.
 * Validation split: if a class was photographed in 2+ separate sessions, the
 * newest session is held out (an honest test: different moment, different
 * angle). With a single session every 5th photo is held out, and the README in
 * the zip warns that this flatters the accuracy (neighbouring frames look alike).
 * @param {(code:string)=>Promise<object|undefined>} describe  returns product details for a barcode
 */
export async function exportDataset(describe) {
  const keys = (await store.keys("photos")) || [];
  const vals = (await store.all("photos")) || [];
  const byClass = {};
  keys.forEach((k, i) => { (byClass[vals[i].code] ||= []).push({ k, ...vals[i] }); });

  const files = [];
  const meta = {};
  const notes = [];
  for (const [code, items] of Object.entries(byClass)) {
    // sessions with at least 5 photos count; if there are two or more, the newest is held out
    const size = {};
    items.forEach((i) => { size[i.session] = (size[i.session] || 0) + 1; });
    const sessions = Object.keys(size).filter((s) => size[s] >= 5).sort();
    const heldOut = sessions.length >= 2 ? new Set([sessions[sessions.length - 1]]) : null;
    items.sort((a, b) => (a.k < b.k ? -1 : 1));
    let val = 0;
    items.forEach((it, idx) => {
      const isVal = heldOut ? heldOut.has(it.session) : idx % 5 === 4;
      if (isVal) val++;
      files.push({ _blob: it.blob, name: `dataset/${isVal ? "val" : "train"}/${code}/${it.k.replace(/\|/g, "_")}.jpg` });
    });
    const p = code === OTHER ? { name: "Other / not a product" } : (await describe(code)) || {};
    meta[code] = { name: p.name || "", brand: p.brand || "", quantity: p.quantity || "", mrp: p.mrp || "", diet: p.diet || "unknown", photos: items.length };
    if (code !== OTHER && items.length < 30) notes.push(`${code} (${p.name || "?"}): only ${items.length} photos, aim for 40 or more`);
    if (!heldOut) notes.push(`${code}: one photo session only, so validation photos are neighbours of training photos; accuracy will look better than it is`);
  }
  if (!Object.keys(byClass).length) return null;
  if (!byClass[OTHER]) notes.push(`No "other" photos: the model will never be able to say "not one of my products". Add 100+ photos of other packs and backgrounds.`);

  for (const f of files) f.data = new Uint8Array(await f._blob.arrayBuffer());
  const enc = new TextEncoder();
  files.push({ name: "classes.json", data: enc.encode(JSON.stringify(meta, null, 2)) });
  files.push({
    name: "README.txt",
    data: enc.encode(
      "Training data exported from Grocery Voice Assistant.\n\n" +
      "Train on a computer with Python (a GPU makes it fast):\n" +
      "  pip install ultralytics\n" +
      "  python training/train_products.py training-data.zip\n\n" +
      "Then copy the two output files into docs/model/ (see training/README.md in the repo).\n\n" +
      (notes.length ? "Heads up:\n- " + notes.join("\n- ") + "\n" : "")
    ),
  });
  return { blob: makeZip(files), classes: Object.keys(byClass).length, photos: keys.length, notes };
}
