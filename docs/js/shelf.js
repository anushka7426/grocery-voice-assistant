// Shelf mode: find every product in the camera view, follow each across frames,
// work out which product each one is, and describe the shelf by position.
//
//   camera frame -> detector (boxes) -> tracker (identity over time)
//        -> embedding of each new box -> nearest saved product (refs.js)
//        -> vote over several frames -> speech
//
// The detector is class-agnostic: it only says "a product is here". Which product
// it is comes from matching against saved photos, so a new product needs a few
// photos, not retraining.

import { Tracker } from "./tracker.js";
import * as refsLib from "./refs.js";
import { embed } from "./embed.js";
import * as vision from "./vision.js";
import { gtinValid } from "./gtin.js";

export const CFG = {
  maxSide: 960,          // frame size sent to the detector
  everyMs: 700,          // pause between frames (keeps a phone cool)
  minHits: 3,            // frames a box must survive before it is spoken about
  simMin: 0.72,          // cosine similarity needed to accept a match
  margin: 0.04,          // and the lead it must have over the runner-up product
  votesNeeded: 2,        // agreeing frames needed to settle an identity
  maxTries: 6,           // embedding attempts per track before giving up
  embedPerFrame: 3,      // limit work per frame
  announceGapMs: 7000,
};

export const position = (box, width) => {
  const x = (box[0] + box[2]) / 2 / width;
  return x < 1 / 3 ? "left" : x < 2 / 3 ? "middle" : "right";
};

const at = (pos) => (pos === "middle" ? "in the middle" : `on the ${pos}`);
const label = (n) => (n.brand && !n.name.toLowerCase().includes(n.brand.toLowerCase()) ? `${n.brand} ${n.name}` : n.name);

/** Words for one set of products: "2 Parle-G, 1 Vicks VapoRub" */
function listNames(items) {
  const c = new Map();
  for (const n of items) c.set(n, (c.get(n) || 0) + 1);
  return [...c].map(([n, k]) => (k > 1 ? `${k} ${n}` : n)).join(", ");
}

/**
 * Sentence describing the shelf.
 * @param tracks settled tracks (each has .box and .name when identified)
 * @param width frame width
 */
export function describe(tracks, width, { hasRefs = true } = {}) {
  const n = tracks.length;
  if (!n) return "I cannot see any products. Move the phone slowly along the shelf, about an arm's length away.";
  const known = tracks.filter((t) => t.name), unknown = n - known.length;
  const head = `I can see ${n} product${n > 1 ? "s" : ""}.`;
  if (!known.length) {
    return hasRefs
      ? `${head} I could not identify ${n > 1 ? "them" : "it"}. Hold steady, or say read the middle product.`
      : `${head} I do not know ${n > 1 ? "which products they are" : "which product it is"} yet. Say teach this product to show me the one in the middle, or take training photos first.`;
  }
  const parts = [];
  for (const pos of ["left", "middle", "right"]) {
    const here = known.filter((t) => position(t.box, width) === pos).sort((a, b) => a.box[0] - b.box[0]);
    if (here.length) parts.push(`${pos[0].toUpperCase() + pos.slice(1)}: ${listNames(here.map((t) => t.name))}`);
  }
  const tail = unknown ? `${unknown} could not be identified.` : "";
  return [head, parts.join(". ") + ".", tail].filter(Boolean).join(" ");
}

/** Internal barcode for a product taught from the shelf (GS1 "2" prefix is reserved for in-store use). */
export function internalCode() {
  let body = "2" + String(Date.now()).slice(-9) + String(Math.floor(Math.random() * 90) + 10);
  body = body.slice(0, 12);
  let s = 0;
  for (let i = 0; i < 12; i++) s += Number(body[11 - i]) * (i % 2 === 0 ? 3 : 1);
  const code = body + ((10 - (s % 10)) % 10);
  return gtinValid(code) ? code : internalCode();
}

export class ShelfScanner {
  /**
   * @param grab   () => canvas   current camera frame
   * @param say    (text, {append}) => Promise   speaks
   * @param nameOf (code) => Promise<{name,brand}|null>
   */
  constructor({ grab, say, nameOf, onStatus = () => {} }) {
    Object.assign(this, { grab, say, nameOf, onStatus });
    this.tracker = new Tracker();
    this.running = false;
    this.detectFn = null;      // test hook
    this.width = 0; this.height = 0;
    this.names = new Map();    // code -> label
    this.lastAnnounce = 0;
    this.frame = null;         // latest canvas
    this.refs = [];
    this.mode = "none";
  }

  setDetector(fn) { this.detectFn = fn; this.mode = "custom"; }

  async _pickDetector() {
    if (this.detectFn) return;
    if (await vision.shelfDetector.load()) {
      this.mode = "shelf";
      this.detectFn = (c) => vision.shelfDetector.detect(c, { conf: 0.3, nms: 0.5, agnostic: true });
    } else if (await vision.warmUp(), vision.names().length) {
      // no shelf model yet: reuse the 25-product detector, ignoring which class it thinks it is
      this.mode = "fallback";
      this.detectFn = (c) => vision.detect(c, { conf: 0.15, nms: 0.5, agnostic: true });
    } else {
      this.mode = "none";
    }
  }

  async start() {
    if (this.running) return;
    await this._pickDetector();
    if (this.mode === "none") {
      await this.say("The shelf detector is not available. Open the app once with internet so it can download the models.");
      return false;
    }
    this.refs = await refsLib.loadRefs(true);
    for (const r of this.refs) if (!this.names.has(r.code)) { const n = await this.nameOf(r.code); if (n) this.names.set(r.code, label(n)); }
    this.tracker = new Tracker();
    this.running = true;
    this.lastAnnounce = Date.now();
    this._loop();
    return true;
  }

  stop() { this.running = false; }

  async _loop() {
    let announcedFirst = false;
    while (this.running) {
      const t0 = Date.now();
      try { await this.step(); } catch (e) { this.lastError = e; }
      const settled = this.settled();
      if (!announcedFirst && settled.length && Date.now() - this.started > 2500) {
        announcedFirst = true; this.lastAnnounce = Date.now();
        await this.say(this.describeNow());
      } else if (announcedFirst) await this._announceNew();
      const wait = Math.max(50, CFG.everyMs - (Date.now() - t0));
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  get started() { return this._started ??= Date.now(); }

  /** One frame: detect, track, identify. Exposed so tests can drive it. */
  async step(canvas = null) {
    const frame = canvas || this.grab(CFG.maxSide);
    this.frame = frame; this.width = frame.width; this.height = frame.height;
    const dets = await this.detectFn(frame);
    const tracks = this.tracker.update(dets);
    let budget = CFG.embedPerFrame;
    const now = Date.now();
    for (const t of tracks) {
      if (budget <= 0) break;
      if (t.missed > 0 || t.hits < 2 || t.ident || t.tries >= CFG.maxTries) continue;
      if (!this.refs.length) break;
      if (now - t.lastTry < 300) continue;
      t.lastTry = now; t.tries++; budget--;
      const vec = await embed(frame, t.box);
      if (!vec) break;
      const m = refsLib.match(vec, this.refs);
      if (m && m.sim >= CFG.simMin && m.sim - m.second >= CFG.margin) {
        t.obs.push({ code: m.code, sim: m.sim });
        const votes = t.obs.filter((o) => o.code === m.code).length;
        if (votes >= CFG.votesNeeded) {
          t.ident = { code: m.code, sim: t.obs.filter((o) => o.code === m.code).reduce((s, o) => s + o.sim, 0) / votes };
          if (!this.names.has(m.code)) { const n = await this.nameOf(m.code); this.names.set(m.code, n ? label(n) : "an unnamed product"); }
        }
      } else t.obs.push({ code: null, sim: m?.sim || 0 });
    }
    return tracks;
  }

  /** Tracks stable enough to talk about, with their names attached. */
  settled() {
    return this.tracker.tracks
      .filter((t) => t.hits >= CFG.minHits && t.missed <= 1)
      .map((t) => Object.assign(t, { name: t.ident ? this.names.get(t.ident.code) : null }));
  }

  describeNow() { return describe(this.settled(), this.width || 1, { hasRefs: this.refs.length > 0 }); }

  async _announceNew() {
    if (Date.now() - this.lastAnnounce < CFG.announceGapMs) return;
    const fresh = this.settled().filter((t) => t.name && !t.announced);
    if (!fresh.length) return;
    fresh.forEach((t) => { t.announced = true; });
    this.lastAnnounce = Date.now();
    const bits = fresh.map((t) => `${t.name} ${at(position(t.box, this.width))}`);
    await this.say(`Now also: ${bits.join(", ")}.`, { append: true });
  }

  /** Mark everything currently settled as already spoken. */
  markAllAnnounced() { this.settled().forEach((t) => { t.announced = true; }); }

  /** Where is the product matching `words`? */
  where(words) {
    const q = words.toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !["the", "where", "find", "locate", "for", "and"].includes(w));
    if (!q.length) return "Say which product you are looking for.";
    const hits = this.settled().filter((t) => t.name && q.some((w) => t.name.toLowerCase().includes(w)));
    if (!hits.length) return "I cannot see that product right now. Move the phone slowly along the shelf.";
    return hits.map((t) => `${t.name} is ${at(position(t.box, this.width))}`).join(". ") + ".";
  }

  /** What is on the left / middle / right. */
  side(pos) {
    const here = this.settled().filter((t) => position(t.box, this.width) === pos);
    if (!here.length) return `I cannot see any product ${at(pos)}.`;
    const known = here.filter((t) => t.name).map((t) => t.name);
    const un = here.length - known.length;
    return `${at(pos)[0].toUpperCase() + at(pos).slice(1)}: ${[known.length ? listNames(known) : "", un ? `${un} could not be identified` : ""].filter(Boolean).join(", ")}.`;
  }

  /** The settled track closest to the middle of the picture. */
  centreTrack() {
    const s = this.settled();
    if (!s.length) return null;
    const cx = this.width / 2;
    return s.slice().sort((a, b) => Math.abs((a.box[0] + a.box[2]) / 2 - cx) - Math.abs((b.box[0] + b.box[2]) / 2 - cx))[0];
  }

  /** Cut a track out of the latest frame. */
  crop(track, frame = this.frame) {
    const [x0, y0, x1, y1] = track.box.map(Math.round);
    const c = document.createElement("canvas");
    c.width = Math.max(1, x1 - x0); c.height = Math.max(1, y1 - y0);
    c.getContext("2d").drawImage(frame, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
    return c;
  }

  /**
   * Collect crops of the middle product over several frames (different angles/blur).
   * @returns {Promise<HTMLCanvasElement[]>}
   */
  async collectCrops(n = 8) {
    const crops = [];
    for (let i = 0; i < n * 3 && crops.length < n; i++) {
      const t = this.centreTrack();
      if (t && t.missed === 0) crops.push(this.crop(t));
      await new Promise((r) => setTimeout(r, 350));
    }
    return crops;
  }
}
