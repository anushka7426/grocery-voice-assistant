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
from PIL import Image, ImageEnhance, ImageFilter

p = argparse.ArgumentParser()
p.add_argument("--photos", required=True)
p.add_argument("--model", default="docs/model/embed.onnx")
p.add_argument("--out", default="docs/model/refs.json")
p.add_argument("--max-per", type=int, default=12, help="photos used per product")
p.add_argument("--augment", type=int, default=0,
               help="extra shelf-like variants made from each photo (blur, angle, light, partial crop). "
                    "Recommended 3 for studio/e-commerce photos; each one adds a vector (about 1.7 KB) to refs.json")
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


def augment(im, rng):
    """Make a studio photo look more like a shelf crop: angle, partial crop, light, blur, compression."""
    W, H = im.size
    # partial crop (a neighbour or the shelf edge hides part of the pack)
    cx0, cy0 = rng.uniform(0, 0.12) * W, rng.uniform(0, 0.12) * H
    cx1, cy1 = W - rng.uniform(0, 0.12) * W, H - rng.uniform(0, 0.12) * H
    im = im.crop((int(cx0), int(cy0), int(cx1), int(cy1)))
    # slight perspective: shear + rotation
    im = im.rotate(rng.uniform(-8, 8), resample=Image.BILINEAR, expand=False, fillcolor=(128, 128, 128))
    w, h = im.size
    sh = rng.uniform(-0.12, 0.12)
    im = im.transform((w, h), Image.AFFINE, (1, sh, -sh * h / 2, 0, 1, 0), resample=Image.BILINEAR, fillcolor=(128, 128, 128))
    im = ImageEnhance.Brightness(im).enhance(rng.uniform(0.65, 1.25))
    im = ImageEnhance.Contrast(im).enhance(rng.uniform(0.7, 1.2))
    im = ImageEnhance.Color(im).enhance(rng.uniform(0.7, 1.2))
    # low resolution, as when the product is far from the camera
    s = rng.uniform(0.25, 0.7)
    im = im.resize((max(8, int(w * s)), max(8, int(h * s))), Image.BILINEAR).resize((w, h), Image.BILINEAR)
    if rng.random() < 0.5:
        im = im.filter(ImageFilter.GaussianBlur(rng.uniform(0.5, 1.6)))
    return im


def pack(v):
    return base64.b64encode(np.clip(np.round(v * 127), -127, 127).astype(np.int8).tobytes()).decode()


root = Path(a.photos)
meta = json.loads((root / "products.json").read_text()) if (root / "products.json").exists() else {}
out = {"dim": 1280, "products": {}}
random.seed(0)
rng = random.Random(0)
for d in sorted(x for x in root.iterdir() if x.is_dir() and x.name != "other"):
    files = sorted(f for f in d.iterdir() if f.suffix.lower() in {".jpg", ".jpeg", ".png"})
    random.shuffle(files)
    vecs = []
    for f in files[: a.max_per]:
        im = Image.open(f).convert("RGB")
        box = label_box(f, *im.size)
        vecs.append(pack(embed(im, box)))
        if a.augment:
            base = im.crop(tuple(int(v) for v in box)) if box else im
            for _ in range(a.augment):
                vecs.append(pack(embed(augment(base, rng))))
    if vecs:
        out["products"][d.name] = {**meta.get(d.name, {"name": d.name}), "vecs": vecs}
Path(a.out).write_text(json.dumps(out))
print(f"{len(out['products'])} products, {sum(len(p['vecs']) for p in out['products'].values())} vectors -> {a.out}")
