// Reference vectors: one embedding per saved photo of a product.
//   * from photos taken in the app (IndexedDB "photos" -> "refs"), and
//   * optionally bundled in model/refs.json (built on a computer from a photo
//     dataset with training/build_refs.py).
// match() finds the saved product closest to a new vector.

import * as store from "./store.js";
import { embed, cosine, unpack } from "./embed.js";

let bundled = null, cache = null;

async function loadBundled() {
  if (bundled) return bundled;
  try {
    const r = await fetch(new URL("../model/refs.json", import.meta.url));
    if (!r.ok) throw new Error("none");
    const j = await r.json();
    const list = [], info = {};
    for (const [code, p] of Object.entries(j.products || {})) {
      info[code] = { name: p.name, brand: p.brand, quantity: p.quantity, mrp: p.mrp, diet: p.diet };
      for (const v of p.vecs || []) list.push({ code, vec: unpack(v) });
    }
    bundled = { list, info };
  } catch { bundled = { list: [], info: {} }; }
  return bundled;
}
export const bundledInfo = async (code) => (await loadBundled()).info[code];

/** Every reference vector available now: [{code, vec}] */
export async function loadRefs(force = false) {
  if (cache && !force) return cache;
  const b = await loadBundled();
  const keys = (await store.keys("refs")) || [];
  const vals = (await store.all("refs")) || [];
  cache = [...b.list, ...vals.map((v, i) => ({ code: v.code, vec: v.vec instanceof Float32Array ? v.vec : Float32Array.from(v.vec), key: keys[i] }))];
  return cache;
}
export const invalidate = () => { cache = null; };

/** Save the vector of one photo (key = the photo's key, or a new key). */
export async function addRef(key, code, vec) {
  await store.put("refs", key, { code, vec });
  cache = null;
}

/**
 * Make vectors for photos that do not have one yet. `cropBox(canvas)` may return
 * the box of the product inside a photo (so the shelf background is left out).
 */
export async function indexPhotos({ cropBox = null, onProgress = () => {} } = {}) {
  const pk = (await store.keys("photos")) || [];
  if (!pk.length) return 0;
  const have = new Set((await store.keys("refs")) || []);
  const pv = (await store.all("photos")) || [];
  const todo = pk.map((k, i) => ({ k, v: pv[i] })).filter((x) => !have.has(x.k) && x.v?.blob && x.v.code !== "other");
  let done = 0;
  for (const { k, v } of todo) {
    try {
      const bmp = await createImageBitmap(v.blob);
      const box = cropBox ? await cropBox(bmp) : null;
      const vec = await embed(bmp, box);
      if (vec) await addRef(k, v.code, vec);
    } catch { /* skip a bad photo */ }
    onProgress(++done, todo.length);
  }
  return done;
}

/**
 * Closest product. Score for a product = mean of its best two similarities.
 * @returns {{code:string, sim:number, second:number}|null}
 */
export function match(vec, refs) {
  if (!refs.length) return null;
  const by = new Map();
  for (const r of refs) {
    const s = cosine(vec, r.vec);
    const a = by.get(r.code) || [];
    a.push(s); by.set(r.code, a);
  }
  const scored = [];
  for (const [code, a] of by) {
    a.sort((x, y) => y - x);
    scored.push({ code, sim: a.length > 1 ? (a[0] + a[1]) / 2 : a[0] });
  }
  scored.sort((x, y) => y.sim - x.sim);
  return { code: scored[0].code, sim: scored[0].sim, second: scored[1]?.sim ?? 0 };
}
