"""Pre-label shelf photos with the SKU-110K detector so you only have to CORRECT boxes.

    python training/prelabel_shelves.py --images my_shelf_photos --model runs/shelf/weights/best.pt

Writes a YOLO dataset ready for editing and fine-tuning:
    indian_shelves/images/{train,val}/*.jpg
    indian_shelves/labels/{train,val}/*.txt     one line per box:  0 cx cy w h  (0..1)
    indian_shelves/shelves.yaml
    indian_shelves/review_first.txt             photos where the model was least sure: fix these first

Fix the boxes in any YOLO-format editor (CVAT, Roboflow, labelImg, Label Studio):
open images/ and labels/, delete wrong boxes, add missed ones. Then fine-tune:
    python training/train_shelf_detector.py --model runs/shelf/weights/best.pt \\
        --data indian_shelves/shelves.yaml --epochs 40 --name shelf_india

Photos of shelves you took yourself are best. Photos copied from websites are fine
for private study, but check the licence before sharing them.
"""
import argparse, random, shutil
from pathlib import Path
from ultralytics import YOLO

p = argparse.ArgumentParser()
p.add_argument("--images", required=True)
p.add_argument("--model", default="runs/shelf/weights/best.pt")
p.add_argument("--out", default="indian_shelves")
p.add_argument("--conf", type=float, default=0.25, help="lower finds more products but more false ones")
p.add_argument("--imgsz", type=int, default=960, help="larger than 640 helps on dense shelves")
p.add_argument("--val", type=float, default=0.15, help="share of photos held back for checking")
p.add_argument("--max-det", type=int, default=300)
a = p.parse_args()

src = sorted(f for f in Path(a.images).rglob("*") if f.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"})
if not src:
    raise SystemExit(f"no images in {a.images}")
random.Random(0).shuffle(src)
n_val = max(1, int(len(src) * a.val)) if len(src) > 5 else 0
model = YOLO(a.model)
out = Path(a.out)
review = []
for i, f in enumerate(src):
    split = "val" if i < n_val else "train"
    (out / "images" / split).mkdir(parents=True, exist_ok=True)
    (out / "labels" / split).mkdir(parents=True, exist_ok=True)
    name = f"{i:05d}{f.suffix.lower()}"
    shutil.copy(f, out / "images" / split / name)
    r = model.predict(str(f), conf=a.conf, imgsz=a.imgsz, max_det=a.max_det, agnostic_nms=True, verbose=False)[0]
    lines = [f"0 {x:.6f} {y:.6f} {w:.6f} {h:.6f}" for x, y, w, h in r.boxes.xywhn.tolist()]   # every class -> "product"
    (out / "labels" / split / f"{i:05d}.txt").write_text("\n".join(lines) + ("\n" if lines else ""))
    confs = r.boxes.conf.tolist()
    review.append((sum(confs) / len(confs) if confs else 0.0, len(confs), f"{split}/{name}"))
review.sort()
(out / "review_first.txt").write_text("\n".join(f"{m:.2f} mean confidence, {n} boxes: {nm}" for m, n, nm in review))
(out / "shelves.yaml").write_text(f"path: {out.resolve()}\ntrain: images/train\nval: images/{'val' if n_val else 'train'}\nnames:\n  0: product\n")
print(f"{len(src)} photos pre-labelled in {out}/ ({n_val} for validation). Correct the boxes, starting with review_first.txt.")
