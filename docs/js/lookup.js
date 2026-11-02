// Product lookup cascade (offline first):
//   1. products the user taught the app   (IndexedDB "custom")
//   2. bundled Indian records             (data/products-in.json)
//   3. products fetched before            (IndexedDB "cache")
//   4. Open Food Facts                    (only if online)
// A found record is never invented: if nothing matches we say so.

import * as store from "./store.js";
import { normalise } from "./gtin.js";

const OFF = "https://world.openfoodfacts.org/api/v2/product/";
const FIELDS = [
  "product_name", "product_name_en", "generic_name", "brands", "quantity",
  "ingredients_text", "ingredients_text_en", "allergens_tags", "traces_tags",
  "nutriments", "ingredients_analysis_tags", "categories",
].join(",");

let bundled = null;
async function loadBundled() {
  if (!bundled) {
    try {
      const r = await fetch(new URL("../data/products-in.json", import.meta.url));
      bundled = await r.json();
    } catch { bundled = { products: {}, prefixes: {} }; }
  }
  return bundled;
}

const clean = (s) => (s || "").toString().replace(/\s+/g, " ").trim();
const tagName = (t) => clean(t.replace(/^[a-z]{2}:/, "").replace(/-/g, " "));

function fromOFF(p) {
  const tags = p.ingredients_analysis_tags || [];
  let diet = "unknown";
  if (tags.includes("en:non-vegetarian")) diet = "non-vegetarian";
  else if (tags.includes("en:vegetarian")) diet = "vegetarian";
  const n = p.nutriments || {};
  const num = (v) => (typeof v === "number" ? Math.round(v * 10) / 10 : null);
  const nutrition = {
    energy_kcal: num(n["energy-kcal_100g"]),
    fat: num(n.fat_100g),
    sugars: num(n.sugars_100g),
    proteins: num(n.proteins_100g),
    salt: num(n.salt_100g),
    carbs: num(n.carbohydrates_100g),
  };
  const hasNutrition = Object.values(nutrition).some((v) => v !== null);
  return {
    name: clean(p.product_name_en || p.product_name || p.generic_name),
    brand: clean(p.brands).split(",")[0] || "",
    quantity: clean(p.quantity),
    ingredients: clean(p.ingredients_text_en || p.ingredients_text),
    allergens: Array.isArray(p.allergens_tags) ? p.allergens_tags.map(tagName) : null,
    traces: Array.isArray(p.traces_tags) ? p.traces_tags.map(tagName) : null,
    nutrition: hasNutrition ? nutrition : null,
    diet,
    source: "Open Food Facts",
  };
}

async function fetchOnline(code) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 7000);
  try {
    const r = await fetch(`${OFF}${code}.json?fields=${FIELDS}`, { signal: ctl.signal });
    if (r.status === 404) return { found: false };
    if (!r.ok) return { error: true };
    const j = await r.json();
    if (j.status !== 1 || !j.product) return { found: false };
    const rec = fromOFF(j.product);
    if (!rec.name) return { found: false };   // empty shell record: not useful
    return { found: true, product: rec };
  } catch {
    return { error: true };
  } finally {
    clearTimeout(timer);
  }
}

/** @returns {{product?:object, status:'found'|'notfound'|'offline', hint?:string}} */
export async function lookup(rawCode) {
  const code = normalise(rawCode);
  const alt = rawCode;                       // also try the code as scanned
  const db = await loadBundled();

  for (const c of [code, alt]) {
    const mine = await store.get("custom", c);
    if (mine) return { status: "found", product: { ...mine, source: "saved on this phone" } };
    const b = db.products[c];
    if (b) return { status: "found", product: normaliseLocal(b) };
    const cached = await store.get("cache", c);
    if (cached) return { status: "found", product: cached };
  }

  let online = null;
  if (navigator.onLine !== false) {
    online = await fetchOnline(code);
    if (online.found) {
      await store.put("cache", code, online.product);
      return { status: "found", product: online.product };
    }
  }
  const hint = db.prefixes[code.slice(0, 7)] || db.prefixes[rawCode.slice(0, 7)] || "";
  const couldntReach = !online || online.error;
  return { status: couldntReach ? "offline" : "notfound", hint };
}

function normaliseLocal(b) {
  return {
    name: b.name || "", brand: b.brand || "", quantity: b.quantity || "",
    ingredients: b.ingredients || "", allergens: b.allergens ?? null,
    traces: null, nutrition: b.nutrition || null, diet: b.diet || "unknown", mrp: b.mrp || "",
    source: b.source || "built-in list",
  };
}

export async function saveCustom(rawCode, product) {
  await store.put("custom", normalise(rawCode), product);
}

export async function deleteCustom(rawCode) {
  await store.del("custom", normalise(rawCode));
}

/** Products saved on this phone: [{code, ...product}] */
export async function listCustom() {
  const k = (await store.keys("custom")) || [];
  const v = (await store.all("custom")) || [];
  return k.map((code, i) => ({ code, ...v[i] }));
}

/** Every known product name/brand, for matching text read from a label. */
export async function allKnown() {
  const db = await loadBundled();
  const list = [];
  for (const [code, p] of Object.entries(db.products)) list.push({ code, ...normaliseLocal(p) });
  const keys = (await store.keys("custom")) || [];
  const vals = (await store.all("custom")) || [];
  keys.forEach((k, i) => list.push({ code: k, ...vals[i] }));
  const ck = (await store.keys("cache")) || [];
  const cv = (await store.all("cache")) || [];
  ck.forEach((k, i) => list.push({ code: k, ...cv[i] }));
  return list;
}
