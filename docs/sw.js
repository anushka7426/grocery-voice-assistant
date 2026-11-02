// Offline support: the app shell and scanner are cached on install; the text
// reader and the camera model (large) are cached the first time they are used while online.
// Open Food Facts requests are never cached here (app code caches results itself).

const VERSION = "gva-v6";
const SHELL = [
  "./", "index.html", "styles.css", "manifest.webmanifest",
  "js/app.js", "js/scanner.js", "js/lookup.js", "js/describe.js", "js/speech.js",
  "js/store.js", "js/vision.js", "js/ppocr.js", "js/identify.js", "js/photos.js", "js/zip.js", "js/classifier.js", "js/gtin.js", "js/ocr.js", "data/products-in.json",
  "vendor/zxing/reader/index.js", "vendor/zxing/share.js", "vendor/zxing/zxing_reader.wasm",
  "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) {
        // keep the shell fresh in the background (stale-while-revalidate)
        fetch(req).then((r) => r.ok && caches.open(VERSION).then((c) => c.put(req, r))).catch(() => {});
        return hit;
      }
      return fetch(req).then((r) => {
        if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return r;
      });
    })
  );
});
