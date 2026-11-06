// Tiny IndexedDB key/value wrapper. Every call fails soft: if storage is
// blocked (private mode etc.) the app still works, it just remembers nothing.

const DB = "grocery-voice";
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(DB, 3);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const name of ["cache", "custom", "photos", "refs"]) {   // fetched products, taught products, training photos, reference vectors
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (e) { reject(e); }
    });
  }
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const r = fn(t.objectStore(storeName));
      t.oncomplete = () => resolve(r && "result" in r ? r.result : undefined);
      t.onerror = () => reject(t.error);
    });
  } catch { return undefined; }
}

export const get = (s, k) => tx(s, "readonly", (o) => o.get(k));
export const put = (s, k, v) => tx(s, "readwrite", (o) => o.put(v, k));
export const all = (s) => tx(s, "readonly", (o) => o.getAll());
export const keys = (s) => tx(s, "readonly", (o) => o.getAllKeys());
export const del = (s, k) => tx(s, "readwrite", (o) => o.delete(k));
