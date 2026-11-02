#!/usr/bin/env python3
"""Train the "which of my products is this?" classifier from the zip the app exports.

    pip install ultralytics
    python training/train_products.py training-data.zip              # CPU or GPU, auto
    python training/train_products.py training-data.zip --device 0   # first GPU

Outputs (in --out, default training/out):
    products-cls.onnx   the model the phone app runs
    products-cls.json   class list (barcode -> name, brand, ...) the app needs
Copy both into docs/model/ and redeploy.
"""
import argparse
import json
import shutil
import sys
import zipfile
from pathlib import Path

IMG = {".jpg", ".jpeg", ".png", ".webp"}


def images(folder: Path):
    return sorted(p for p in folder.glob("*") if p.suffix.lower() in IMG)


def prepare(src: Path, work: Path) -> dict:
    """Unpack the export and make sure every class exists in both train/ and val/."""
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    if src.is_file():
        with zipfile.ZipFile(src) as z:
            z.extractall(work)
        root = work
    else:
        shutil.copytree(src, work, dirs_exist_ok=True)
        root = work
    classes = json.loads((root / "classes.json").read_text(encoding="utf-8"))
    data = root / "dataset"
    for split in ("train", "val"):
        (data / split).mkdir(parents=True, exist_ok=True)

    for code in classes:
        tr, va = data / "train" / code, data / "val" / code
        n_tr = len(images(tr)) if tr.exists() else 0
        n_va = len(images(va)) if va.exists() else 0
        if n_tr == 0:
            sys.exit(f"Class {code} has no training photos. Take more photos of it in the app.")
        if n_va == 0:
            # ultralytics needs every class in val; reuse one training photo and say so
            va.mkdir(parents=True, exist_ok=True)
            shutil.copy(images(tr)[-1], va / "copy_of_train.jpg")
            print(f"WARNING: {code} had no validation photos; copied one training photo, "
                  f"so the validation score for this class means nothing. Take another session of photos.")
        print(f"  {code:>16}  {classes[code].get('name', '')[:40]:40}  train {n_tr:3d}  val {max(n_va, 1):3d}")
    if "other" not in classes:
        print('WARNING: no "other" class. Without it the model must pick one of your products for ANY '
              "pack it sees, including ones it has never seen. Add 100+ photos of other packs and "
              "backgrounds (Settings > Take photos of other things).")
    return classes


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("data", type=Path, help="training-data.zip exported by the app")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--imgsz", type=int, default=224)
    ap.add_argument("--model", default="yolov8n-cls.pt", help="starting weights (downloaded automatically)")
    ap.add_argument("--out", type=Path, default=Path("training/out"))
    ap.add_argument("--device", default=None, help="0 for the first GPU, cpu for CPU (default: auto)")
    ap.add_argument("--batch", type=int, default=32)
    a = ap.parse_args()

    from ultralytics import YOLO

    work = a.out / "data"
    print(f"Preparing dataset from {a.data} ...")
    classes = prepare(a.data, work)

    model = YOLO(a.model)
    model.train(
        data=str((work / "dataset").resolve()),
        epochs=a.epochs, imgsz=a.imgsz, batch=a.batch, device=a.device,
        project=str((a.out / "runs").resolve()), name="products", exist_ok=True,
        patience=10, seed=0,
    )
    best = a.out / "runs" / "products" / "weights" / "best.pt"
    net = YOLO(str(best))
    metrics = net.val(data=str((work / "dataset").resolve()), imgsz=a.imgsz, device=a.device,
                      project=str((a.out / "runs").resolve()), name="val", exist_ok=True)
    print(f"\nValidation top-1 accuracy: {metrics.top1:.3f}")

    onnx = Path(net.export(format="onnx", imgsz=a.imgsz, opset=12, simplify=True))
    names = [net.names[i] for i in range(len(net.names))]
    out_onnx, out_json = a.out / "products-cls.onnx", a.out / "products-cls.json"
    shutil.copy(onnx, out_onnx)
    out_json.write_text(json.dumps({"imgsz": a.imgsz, "names": names, "classes": classes},
                                   indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"\nDone. Copy these two files into docs/model/ :\n  {out_onnx}\n  {out_json}")
    print("Then commit and redeploy. Test with products the model has NEVER seen before trusting it.")


if __name__ == "__main__":
    main()
