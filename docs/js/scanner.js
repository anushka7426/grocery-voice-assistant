// Live barcode scanning.
//
// Why this is more reliable than the Python prototype:
//  * It reads many *independent* camera frames and only accepts a code that
//    appears in 3 of the last frames. The prototype "voted" across filtered
//    copies of ONE photo, so one misread could win (it returned
//    5173241139374 for a pack whose barcode is 8901063139374).
//  * Every code must pass the EAN/UPC check digit, AND is then re-read from
//    zoomed crops of the barcode (several scales). Check digits alone are not
//    enough: a decoder can misread a clear barcode as a *different valid*
//    number (seen in testing: 8901063368521 read as 9908463368587). A code
//    is only accepted when the zoomed re-reads agree and none disagree.
//  * Uses the phone's native detector when present, plus zxing (WebAssembly)
//    as a second opinion / fallback for iPhone and older browsers.
//  * Continuous autofocus, high resolution, automatic torch in low light.

import { gtinValid } from "./gtin.js";
import { prepareZXingModule, readBarcodes } from "../vendor/zxing/reader/index.js";

prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) =>
      path.endsWith(".wasm")
        ? new URL("../vendor/zxing/zxing_reader.wasm", import.meta.url).href
        : prefix + path,
  },
});

const NATIVE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];
const ZX_FORMATS = ["EAN-13", "EAN-8", "UPC-A", "UPC-E"];
const NEED = 2;          // agreeing frames required (each already multi-checked)
const WINDOW_MS = 3000;  // ...within this time
// zoomed re-read variants: [scale, canvas filter]
const CONFIRM = [[2, "none"], [3, "none"], [2, "grayscale(1) contrast(1.4)"], [4, "none"], [1, "none"]];

function corners(b) {
  return [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y + b.height }];
}
function boxOf(points) {
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

export class Scanner {
  constructor(video, { onLock, onLight } = {}) {
    this.video = video;
    this.onLock = onLock || (() => {});
    this.onLight = onLight || (() => {});
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.hist = [];
    this.running = false;
    this.paused = false;
    this.frame = 0;
    this.dark = 0;
    this.torchOn = false;
    this.native = null;
  }

  async start() {
    if (this.stream) { this.resume(); return; }
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("no-camera-api");
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.track = this.stream.getVideoTracks()[0];
    try {
      const caps = this.track.getCapabilities?.() || {};
      this.canTorch = !!caps.torch;
      const adv = {};
      if (caps.focusMode?.includes?.("continuous")) adv.focusMode = "continuous";
      if (Object.keys(adv).length) await this.track.applyConstraints({ advanced: [adv] });
    } catch {}
    if ("BarcodeDetector" in window) {
      try {
        const sup = await window.BarcodeDetector.getSupportedFormats();
        const formats = NATIVE_FORMATS.filter((f) => sup.includes(f));
        if (formats.length) this.native = new window.BarcodeDetector({ formats });
      } catch {}
    }
    this.running = true;
    this.paused = false;
    this._tick();
  }

  pause() { this.paused = true; }
  resume() { this.hist = []; this.paused = false; if (!this.running) { this.running = true; this._tick(); } }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  async setTorch(on) {
    if (!this.canTorch) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: on }] });
      this.torchOn = on;
      return true;
    } catch { return false; }
  }

  /** Current frame as a canvas (used by the label reader). */
  snapshot(maxSide = 1800) {
    const { videoWidth: w, videoHeight: h } = this.video;
    const s = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * s); c.height = Math.round(h * s);
    c.getContext("2d").drawImage(this.video, 0, 0, c.width, c.height);
    return c;
  }

  async _tick() {
    if (!this.running) return;
    const t0 = performance.now();
    if (!this.paused && this.video.readyState >= 2 && this.video.videoWidth) {
      try { await this._step(); } catch { /* keep scanning */ }
    }
    setTimeout(() => this._tick(), Math.max(0, 80 - (performance.now() - t0)));
  }

  async _step() {
    this.frame++;
    const { videoWidth: vw, videoHeight: vh } = this.video;
    const s = Math.min(1, 1600 / Math.max(vw, vh));
    this.canvas.width = Math.round(vw * s);
    this.canvas.height = Math.round(vh * s);
    this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);

    if (this.frame % 8 === 0) this._checkLight();

    // 1) find candidates (code + where it is in the frame)
    const cands = [];
    if (this.native) {
      try {
        const r = await this.native.detect(this.canvas);
        for (const b of r) cands.push({ code: b.rawValue, box: boxOf(b.cornerPoints || corners(b.boundingBox)), native: true });
      } catch {}
    }
    // zxing every frame if there is no native detector, else every 3rd frame
    if (!cands.length && (!this.native || this.frame % 3 === 0)) {
      const img = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
      const r = await readBarcodes(img, {
        formats: ZX_FORMATS, tryHarder: true, tryRotate: true,
        tryInvert: true, tryDownscale: true, maxNumberOfSymbols: 2,
      });
      for (const x of r) if (x.isValid !== false) cands.push({ code: x.text, box: boxOf(Object.values(x.position)), native: false });
    }

    // 2) confirm each candidate by re-reading zoomed crops
    const now = performance.now();
    this.hist = this.hist.filter((h) => now - h.t < WINDOW_MS);
    for (const c of cands) {
      if (!gtinValid(c.code)) continue;
      const sure = await this._confirm(c);
      if (sure) this.hist.push({ code: sure, t: now });
    }

    const count = {};
    for (const h of this.hist) count[h.code] = (count[h.code] || 0) + 1;
    const [best, n] = Object.entries(count).sort((a, b) => b[1] - a[1])[0] || [];
    if (best && n >= NEED) {
      this.hist = [];
      this.paused = true;
      this.onLock(best);
    }
  }

  /** Re-read the barcode from zoomed crops; return the consensus code or null. */
  async _confirm({ code, box, native }) {
    const W = this.canvas.width, H = this.canvas.height;
    const w = Math.max(1, box.x1 - box.x0), h = Math.max(1, box.y1 - box.y0);
    const padX = 0.25 * w, padY = Math.max(0.3 * w, 0.6 * h);
    const sx = Math.max(0, Math.floor(box.x0 - padX)), sy = Math.max(0, Math.floor(box.y0 - padY));
    const sw = Math.min(W, Math.ceil(box.x1 + padX)) - sx, sh = Math.min(H, Math.ceil(box.y1 + padY)) - sy;
    if (sw < 20 || sh < 8) return null;
    const votes = {};
    if (native) votes[code] = 1;                 // native detector = one independent opinion
    const c = document.createElement("canvas");
    const g = c.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingQuality = "high";
    for (const [scale, filter] of CONFIRM) {
      if (sw * scale > 2600) continue;
      c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
      g.filter = filter;
      g.drawImage(this.canvas, sx, sy, sw, sh, 0, 0, c.width, c.height);
      const r = await readBarcodes(g.getImageData(0, 0, c.width, c.height), {
        formats: ZX_FORMATS, tryHarder: true, tryRotate: true, tryInvert: true, maxNumberOfSymbols: 1,
      });
      for (const x of r) if (gtinValid(x.text)) votes[x.text] = (votes[x.text] || 0) + 1;
    }
    const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    const [top, second] = ranked;
    if (top && top[1] >= 3 && (!second || second[1] <= 1)) return top[0];
    return null;
  }

  _checkLight() {
    const c = document.createElement("canvas");
    c.width = 32; c.height = 32;
    const g = c.getContext("2d");
    g.drawImage(this.video, 0, 0, 32, 32);
    const d = g.getImageData(0, 0, 32, 32).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const luma = sum / (d.length / 4);
    this.dark = luma < 45 ? this.dark + 1 : 0;
    if (this.dark >= 3 && this.canTorch && !this.torchOn) {
      this.setTorch(true).then((ok) => ok && this.onLight("on"));
    }
  }
}
