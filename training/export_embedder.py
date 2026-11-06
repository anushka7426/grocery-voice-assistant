"""Export an image-embedding model for shelf matching.

The shelf mode turns each product it sees into a vector and finds the closest
saved reference photo. This script builds that "photo -> vector" model from the
ImageNet-trained YOLOv8n classifier: it keeps everything up to the pooled
feature layer (1280 numbers) and drops the final class layer.

    python training/export_embedder.py                # downloads yolov8n-cls.pt if missing
    python training/export_embedder.py --out docs/model

Writes embed.onnx and embed.json. The same file is used by build_refs.py (Python)
and js/embed.js (browser), so reference vectors made on the computer match the
ones the phone computes.
"""
import argparse, json
from pathlib import Path
import torch, torch.nn as nn
from ultralytics import YOLO


class Embedder(nn.Module):
    def __init__(self, head_model):
        super().__init__()
        layers = head_model.model
        self.body = nn.Sequential(*list(layers)[:-1])
        self.conv = layers[-1].conv
        self.pool = layers[-1].pool

    def forward(self, x):
        return self.pool(self.conv(self.body(x))).flatten(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default="yolov8n-cls.pt")
    ap.add_argument("--imgsz", type=int, default=224)
    ap.add_argument("--out", type=Path, default=Path("docs/model"))
    a = ap.parse_args()
    m = YOLO(a.weights).model.eval().float().cpu()
    emb = Embedder(m).eval()
    x = torch.rand(1, 3, a.imgsz, a.imgsz)
    with torch.no_grad():
        dim = emb(x).shape[1]
    a.out.mkdir(parents=True, exist_ok=True)
    onnx_path = a.out / "embed.onnx"
    torch.onnx.export(emb, x, str(onnx_path), input_names=["images"], output_names=["embedding"],
                      opset_version=12, dynamo=False)
    (a.out / "embed.json").write_text(json.dumps({"imgsz": a.imgsz, "dim": int(dim)}))
    print(f"wrote {onnx_path} ({onnx_path.stat().st_size/1e6:.1f} MB), dim={dim}")


if __name__ == "__main__":
    main()
