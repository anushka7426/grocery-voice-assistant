
from ultralytics import YOLO


def main():
    # Load the pretrained YOLOv8 nano model
    model = YOLO("yolov8n.pt")

    # Train the model on our grocery dataset
    model.train(
        data="dataset/data.yaml",
        epochs=50,
        imgsz=640,
        batch=8,
        device=0,
        workers=2,
        project="runs",
        name="grocery_yolov8n",
        patience=10,
        plots=True,
        seed=42,
    )

    print("\nTraining finished!")
    print("Best model: runs/grocery_yolov8n/weights/best.pt")


if __name__ == "__main__":
    main()
