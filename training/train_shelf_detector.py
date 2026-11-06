"""Train the shelf detector: one class, "product", on SKU-110K (dense retail shelves).

    pip install ultralytics
    python training/train_shelf_detector.py            # downloads SKU-110K (~13 GB) on first run
    python training/train_shelf_detector.py --epochs 100 --batch 16 --device 0

Output: docs/model/shelf-detector.onnx and docs/model/shelf-detector.json.
When those two files exist the app's shelf mode uses them automatically.

The detector only answers "where are products". Which product each box is comes
from matching against saved photos (see docs/js/refs.js), so it never needs
retraining when you add products.

Fine-tune on your own Indian shelf photos afterwards (see prelabel_shelves.py):
    python training/train_shelf_detector.py --model runs/shelf/weights/best.pt --data indian_shelves/shelves.yaml \
        --epochs 40 --name shelf_india --imgsz 640

Licence: ultralytics models are AGPL-3.0; SKU-110K is for non-commercial research.
Check both before using the result commercially.
"""
import argparse, json, shutil
from pathlib import Path
from ultralytics import YOLO

p = argparse.ArgumentParser()
p.add_argument("--model", default="yolov8n.pt", help="start from this pretrained model")
p.add_argument("--data", default="SKU-110K.yaml", help="ultralytics ships this config; it downloads the dataset")
p.add_argument("--epochs", type=int, default=80)
p.add_argument("--imgsz", type=int, default=640)
p.add_argument("--batch", type=int, default=16)
p.add_argument("--device", default=None)
p.add_argument("--out", default="docs/model")
p.add_argument("--name", default="shelf", help="run name; use another for fine-tuning so the first run is kept")
p.add_argument("--max_det", type=int, default=300, help="shelves can hold many products")
a = p.parse_args()

model = YOLO(a.model)
model.train(data=a.data, epochs=a.epochs, imgsz=a.imgsz, batch=a.batch, device=a.device,
            max_det=a.max_det, project="runs", name=a.name, exist_ok=True)
best = Path(f"runs/{a.name}/weights/best.pt")
onnx = YOLO(str(best)).export(format="onnx", imgsz=a.imgsz, opset=12, simplify=True, dynamic=False)
out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
shutil.copy(onnx, out / "shelf-detector.onnx")
(out / "shelf-detector.json").write_text(json.dumps({"imgsz": a.imgsz, "names": ["product"]}))
print("wrote", out / "shelf-detector.onnx", "and shelf-detector.json")
print("Check it:  yolo val model=runs/%s/weights/best.pt data=%s" % (a.name, a.data))
