"""Build reference vectors from a folder of product photos, so the shelf scanner
can recognise those products without any phone photos.

Input layout (one folder per product, named by barcode):
    photos/<barcode>/*.jpg
    photos/products.json      {"<barcode>": {"name": "...", "brand": "...", "quantity": "...", "mrp": "...", "diet": "..."}}
Optional: YOLO label files next to the photos (same name, .txt) are used to crop to the product.

    python training/build_refs.py --photos photos --max-per 12

Output: docs/model/refs.json (bundled with the app). Uses docs/model/embed.onnx,
the same file the phone runs, with the same preprocessing.
"""
import argparse, base64, json, random
from pathlib import Path
import numpy as np
import onnxruntime as ort
from PIL import Image

p = argparse.ArgumentParser()
p.add_argument("--photos", required=True)
p.add_argument("--model", default="docs/model/embed.onnx")
p.add_argument("--out", default="docs/model/refs.json")
p.add_argument("--max-per", type=int, default=12)
a = p.parse_args()

sess = ort.InferenceSession(a.model)
size = json.loads(Path(a.model).with_name("embed.json").read_text())["imgsz"]
PAD = 0.04   # same margin as docs/js/embed.js


def embed(im, box=None):
    W, H = im.size
    x0, y0, x1, y1 = box or (0, 0, W, H)
    px, py = (x1 - x0) * PAD, (y1 - y0) * PAD
    x0, y0, x1, y1 = max(0, x0 - px), max(0, y0 - py), min(W, x1 + px), min(H, y1 + py)
    im = im.crop((int(x0), int(y0), max(int(x0) + 1, int(x1)), max(int(y0) + 1, int(y1)))).resize((size, size), Image.BILINEAR)
    x = (np.asarray(im, dtype=np.float32) / 255).transpose(2, 0, 1)[None]
    v = sess.run(None, {sess.get_inputs()[0].name: x})[0][0]
    return v / (np.linalg.norm(v) or 1)


def label_box(img_path, W, H):
    t = img_path.with_suffix(".txt")
    if not t.exists():
        return None
    rows = [r.split() for r in t.read_text().splitlines() if r.strip()]
    if not rows:
        return None
    _, cx, cy, w, h = (float(v) for v in rows[0][:5])
    return ((cx - w / 2) * W, (cy - h / 2) * H, (cx + w / 2) * W, (cy + h / 2) * H)


def pack(v):
    return base64.b64encode(np.clip(np.round(v * 127), -127, 127).astype(np.int8).tobytes()).decode()


root = Path(a.photos)
meta = json.loads((root / "products.json").read_text()) if (root / "products.json").exists() else {}
out = {"dim": 1280, "products": {}}
random.seed(0)
for d in sorted(x for x in root.iterdir() if x.is_dir() and x.name != "other"):
    files = sorted(f for f in d.iterdir() if f.suffix.lower() in {".jpg", ".jpeg", ".png"})
    random.shuffle(files)
    vecs = []
    for f in files[: a.max_per]:
        im = Image.open(f).convert("RGB")
        vecs.append(pack(embed(im, label_box(f, *im.size))))
    if vecs:
        out["products"][d.name] = {**meta.get(d.name, {"name": d.name}), "vecs": vecs}
Path(a.out).write_text(json.dumps(out))
print(f"{len(out['products'])} products, {sum(len(p['vecs']) for p in out['products'].values())} vectors -> {a.out}")
