# Training the product recogniser on your own photos

The app can learn the products it fails to recognise from photos you take inside it.

## 1. Collect photos (on the phone)

1. Scan a product the app does not know, tap **Save** (or **Add details**) so it has a name.
2. Tap **Take training photos**. The app takes 20 photos, one per second, and tells you when to turn the pack a little. Repeat in a **different place or light** later, a second session per product gives an honest test set.
3. Photograph things that are **not** your products too: **Settings > Take photos of other things**. 100+ photos of other packs, shelves, hands, tables. This "other" class is what lets the model say "I don't know" instead of guessing (your Taka-Tak photo was mistaken for another brand at 86% by the 25-product detector because it had no such class).
4. Aim for 40+ photos per product across at least two sessions.
5. **Settings > My saved products > Export training data** creates `training-data.zip`.

## 2. Train (on your computer)

```bash
pip install ultralytics
python training/train_products.py training-data.zip --device 0   # --device 0 = first GPU; omit for auto
```

This fine-tunes `yolov8n-cls`, prints the validation accuracy, and writes `training/out/products-cls.onnx` and `training/out/products-cls.json`.

## 3. Put the model in the app

Copy both files into `docs/model/`, commit, push, and merge. Reload the app: when a pack cannot be read, the camera model now also tries to recognise it among your products, and speaks the product details if it is clearly ahead of the other classes (>= 85% and 30 points ahead of the runner-up, and not "other").

## Be honest about accuracy

- Photos taken one second apart look almost identical. If a product has only one photo session, the validation score is inflated. Use two sessions in different places.
- Test with a product the model has never seen, and with other packs, before relying on it.
- Retrain whenever you add products; the app keeps your photos on the phone until you delete them.


## Shelf mode scripts
- `train_shelf_detector.py` trains a one-class "product" detector on SKU-110K and writes `docs/model/shelf-detector.onnx` + `.json`.
- `export_embedder.py` writes `docs/model/embed.onnx` (already committed).
- `build_refs.py` turns a folder of product photos into `docs/model/refs.json` so those products are recognised on the shelf.
