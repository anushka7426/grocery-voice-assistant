// "Read label" mode: OCR on the pack, pull out the facts that matter on an
// Indian pack (MRP, best-before, net quantity) and try to match known products.
// OCR is imperfect (curved, shiny plastic), so everything here is reported as
// "text I could read", never as a confirmed identity.

let workerPromise = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { default: T } = await import("../vendor/tesseract/tesseract.esm.min.js");
      const base = new URL("../vendor/tesseract/", import.meta.url).href;
      const w = await T.createWorker("eng", 1, {
        workerPath: base + "worker.min.js",
        corePath: base,
        langPath: base,
        workerBlobURL: false,
        cacheMethod: "none",
      });
      await w.setParameters({ tessedit_pageseg_mode: "11" }); // sparse text: packs are not paragraphs
      return w;
    })().catch((e) => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

export const warmUp = () => getWorker().catch(() => {});

function enhance(src) {
  const c = document.createElement("canvas");
  c.width = src.width; c.height = src.height;
  const g = c.getContext("2d");
  g.filter = "grayscale(1) contrast(1.35)";
  g.drawImage(src, 0, 0);
  return c;
}

export async function readLabel(canvas) {
  const w = await getWorker();
  const { data } = await w.recognize(enhance(canvas));
  const lines = (data.lines || [])
    .filter((l) => l.confidence >= 55 && /[A-Za-z0-9]{3,}/.test(l.text))
    .map((l) => l.text.replace(/\s+/g, " ").trim());
  return { text: lines.join("\n"), lines };
}

export function extractFacts(text) {
  const facts = {};
  const flat = text.replace(/\n/g, " ");
  const mrp = flat.match(/(?:M\.?\s?R\.?\s?P\.?|Rs\.?|₹|INR)[^0-9]{0,25}(\d{1,5}(?:[.,]\d{1,2})?)/i);
  if (mrp) facts.mrp = mrp[1].replace(",", ".");
  const bb = flat.match(/(best\s*before|use\s*by|expiry(?:\s*date)?|exp\.?)\s*[:\-]?\s*([^.\n]{3,40})/i);
  if (bb) facts.bestBefore = `${bb[1].toLowerCase()} ${bb[2].trim()}`;
  const q = flat.match(/net\s*(?:quantity|qty|weight|wt\.?)\s*[:\-]?\s*(\d+(?:\.\d+)?\s*(?:g|gm|kg|ml|l)\b)/i);
  if (q) facts.net = q[1];
  return facts;
}

// ---- matching text against products we already know -----------------------
const tokens = (s) => (s.toLowerCase().match(/[a-z]{3,}/g) || []);

function lev1(a, b) {            // true if edit distance <= 1
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export function matchKnown(text, known) {
  const seen = tokens(text);
  if (!seen.length) return null;
  let best = null;
  for (const p of known) {
    const want = [...new Set([...tokens(p.name || ""), ...tokens(p.brand || "")])];
    if (want.length < 2) continue;
    const hit = want.filter((w) => seen.some((s) => (w.length >= 5 ? lev1(w, s) : w === s)));
    const score = hit.length / want.length;
    if (hit.length >= 2 && score >= 0.6 && (!best || score > best.score)) best = { p, score };
  }
  return best ? best.p : null;
}
