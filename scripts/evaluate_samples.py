from pathlib import Path
import cv2
from ultralytics import YOLO

ROOT = Path.cwd()
IMAGE_DIR = ROOT / "dataset/test/images"
LABEL_DIR = ROOT / "dataset/test/labels"
WEIGHTS = ROOT / "runs/detect/runs/grocery_yolov8n/weights/best.pt"

EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
SAMPLE_COUNT = 20
IOU_THRESHOLD = 0.50


def calculate_iou(a, b):
    x1 = max(a[0], b[0])
    y1 = max(a[1], b[1])
    x2 = min(a[2], b[2])
    y2 = min(a[3], b[3])

    intersection = max(0, x2 - x1) * max(0, y2 - y1)
    area_a = max(0, a[2] - a[0]) * max(0, a[3] - a[1])
    area_b = max(0, b[2] - b[0]) * max(0, b[3] - b[1])
    union = area_a + area_b - intersection

    return intersection / union if union else 0.0


def read_labels(path, width, height):
    objects = []

    for line in path.read_text().splitlines():
        if not line.strip():
            continue

        values = line.split()
        if len(values) < 5:
            continue

        class_id = int(values[0])
        cx, cy, bw, bh = map(float, values[1:5])

        box = [
            (cx - bw / 2) * width,
            (cy - bh / 2) * height,
            (cx + bw / 2) * width,
            (cy + bh / 2) * height,
        ]
        objects.append((class_id, box))

    return objects


def main():
    if not WEIGHTS.is_file():
        raise SystemExit(f"Model weights not found: {WEIGHTS}")

    if not IMAGE_DIR.is_dir() or not LABEL_DIR.is_dir():
        raise SystemExit("Dataset test image/label folders were not found.")

    images = sorted(
        p for p in IMAGE_DIR.iterdir()
        if p.suffix.lower() in EXTENSIONS
        and (LABEL_DIR / f"{p.stem}.txt").is_file()
        and (LABEL_DIR / f"{p.stem}.txt").read_text().strip()
    )

    if not images:
        raise SystemExit("No labelled test images found.")

    count = min(SAMPLE_COUNT, len(images))
    step = max(1, len(images) // count)
    selected = images[::step][:count]

    model = YOLO(str(WEIGHTS))
    total_gt = 0
    correct = 0

    for image_path in selected:
        image = cv2.imread(str(image_path))
        if image is None:
            print(f"\nSKIP: Cannot read {image_path.name}")
            continue

        height, width = image.shape[:2]
        label_path = LABEL_DIR / f"{image_path.stem}.txt"
        truth = read_labels(label_path, width, height)

        result = model.predict(
            source=str(image_path),
            imgsz=640,
            conf=0.25,
            save=False,
            verbose=False,
        )[0]

        predictions = []
        if result.boxes is not None:
            for box in result.boxes:
                predictions.append((
                    int(box.cls.item()),
                    box.xyxy[0].tolist(),
                    float(box.conf.item()),
                ))

        print(f"\nIMAGE: {image_path.name}")
        unused = set(range(len(predictions)))

        for true_class, true_box in truth:
            total_gt += 1

            if not unused:
                print(f"MISSED: {model.names[true_class]}")
                continue

            best_idx = max(
                unused,
                key=lambda i: calculate_iou(
                    true_box, predictions[i][1]
                ),
            )
            overlap = calculate_iou(
                true_box, predictions[best_idx][1]
            )
            pred_class, _, confidence = predictions[best_idx]
            unused.remove(best_idx)

            passed = (
                pred_class == true_class
                and overlap >= IOU_THRESHOLD
            )

            if passed:
                correct += 1

            status = "PASS" if passed else "MISMATCH"
            print(
                f"{status}: expected={model.names[true_class]} | "
                f"predicted={model.names[pred_class]} | "
                f"confidence={confidence:.3f} | IoU={overlap:.3f}"
            )

        for idx in unused:
            pred_class, _, confidence = predictions[idx]
            print(
                f"EXTRA PREDICTION: {model.names[pred_class]} "
                f"(confidence={confidence:.3f})"
            )

    print("\n" + "=" * 45)
    print(f"Images selected: {len(selected)}")
    print(f"Ground-truth objects: {total_gt}")
    print(f"Correct class and IoU >= {IOU_THRESHOLD}: {correct}")

    if total_gt:
        print(f"Sample pass rate: {correct / total_gt * 100:.1f}%")

    print("This is a sample diagnostic, not full model evaluation.")


if __name__ == "__main__":
    main()
