// Follows each product across video frames so it keeps the same identity
// while the camera pans, and so a product is identified once, not every frame.

const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
export function iou(a, b) {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[2], b[2]), y1 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const u = area(a) + area(b) - inter;
  return u > 0 ? inter / u : 0;
}
const centre = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

export class Tracker {
  constructor({ iouMin = 0.25, maxMissed = 6, smooth = 0.6 } = {}) {
    Object.assign(this, { iouMin, maxMissed, smooth });
    this.tracks = [];
    this.nextId = 1;
  }

  /** @param dets [{box:[x0,y0,x1,y1], conf, index, label}] @returns alive tracks */
  update(dets) {
    const pairs = [];
    this.tracks.forEach((t, ti) => dets.forEach((d, di) => {
      let score = iou(t.box, d.box);
      if (score < this.iouMin) {                       // panning moves boxes: also accept a close centre of similar size
        const [cx, cy] = centre(t.box), [dx, dy] = centre(d.box);
        const size = Math.max(t.box[2] - t.box[0], t.box[3] - t.box[1]);
        const dist = Math.hypot(cx - dx, cy - dy) / (size || 1);
        const ratio = area(d.box) / (area(t.box) || 1);
        if (dist < 0.5 && ratio > 0.5 && ratio < 2) score = 0.2 + (0.5 - dist) * 0.1;
        else score = 0;
      }
      if (score > 0) pairs.push({ ti, di, score });
    }));
    pairs.sort((a, b) => b.score - a.score);
    const usedT = new Set(), usedD = new Set();
    for (const p of pairs) {
      if (usedT.has(p.ti) || usedD.has(p.di)) continue;
      usedT.add(p.ti); usedD.add(p.di);
      const t = this.tracks[p.ti], d = dets[p.di], k = this.smooth;
      t.box = t.box.map((v, i) => k * d.box[i] + (1 - k) * v);
      t.conf = d.conf; t.hits++; t.missed = 0; t.seen = Date.now();
      t.labels[d.label] = (t.labels[d.label] || 0) + (d.conf >= 0.8 ? 1 : 0);
    }
    this.tracks.forEach((t, i) => { if (!usedT.has(i)) t.missed++; });
    dets.forEach((d, i) => {
      if (usedD.has(i)) return;
      this.tracks.push({
        id: this.nextId++, box: d.box.slice(), conf: d.conf, hits: 1, missed: 0, born: Date.now(), seen: Date.now(),
        labels: { [d.label]: d.conf >= 0.8 ? 1 : 0 },
        obs: [],            // embedding observations: {code, sim, second}
        ident: null,        // settled identity {code, sim}
        announced: false, tries: 0, lastTry: 0,
      });
    });
    this.tracks = this.tracks.filter((t) => t.missed <= this.maxMissed);
    return this.tracks;
  }
}
