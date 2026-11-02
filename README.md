# Grocery Voice Assistant

A phone web app that helps blind and low-vision shoppers identify Indian grocery products. Point the camera at a pack: it finds the barcode, looks the product up, and **speaks** the result. It also reads printed label text (MRP, best-before, pack size) aloud.

**Use it:** open the GitHub Pages link on a phone (Chrome on Android recommended), tap *Start scanning*, then use *Add to Home screen* to install it. Works offline after the first load.

## How it works

1. **Barcode** - live camera, native phone detector plus zxing (WebAssembly). Every code must pass the check digit and then be re-read from zoomed crops; a code is spoken only when the re-reads agree.
2. **Lookup (offline first)** - products you taught the app, then `docs/data/products-in.json`, then results cached from earlier scans, then Open Food Facts when online.
3. **Front-of-pack reader** - if the barcode is not in any database, the app asks you to turn the pack to the front, then reads it with an on-device text reader (PaddleOCR PP-OCRv4 via onnxruntime-web; Tesseract is the fallback). `identify.js` works out brand, product type (oil, oats, namkeen...) and name from the text, and pulls out price, net quantity and best-before. **Save** stores the barcode with that name on the phone so it is recognised instantly next time, offline.
4. **Visual recognition (fallback)** - the trained YOLOv8n model (`docs/model/grocery.onnx`, 25 products) runs on the phone via onnxruntime-web. It is a closed-set detector and *will* label unknown packs as one of its 25 classes, so a guess is spoken only if the text read from the pack agrees with it, or (when no text can be read) if it is stable over 3 frames, and then only as "may be ... please confirm".
5. **Voice** - the phone's speech engine; follow-up questions (ingredients, allergens, nutrition, vegetarian) by button or voice.

Missing data is always reported as "not available", never as "none" (important for allergens).

## Run locally

```bash
cd docs
python3 -m http.server 8000     # then open http://localhost:8000 (camera works on localhost)
```

The camera needs HTTPS on a real phone: publish with GitHub Pages (Settings > Pages > Branch `main`, folder `/docs`).

## Add products

- **In the app:** after an unknown scan tap *Add details or correct the name* (name, brand, pack size, price, ingredients, allergens, vegetarian). You can type each field or tap *Say it* to dictate. *Settings > Add a product by hand* adds one without scanning, and *Edit this product* corrects any product. *Settings > My saved products* lists, edits and deletes them, and exports or imports a backup file.
- **Saved products live on that phone only.** Use the backup file to move them to another phone, or merge the `products` entries from it into `docs/data/products-in.json` so every user gets them.
- Leave allergens empty if unknown (the app then says "not available"); type `none` only if the pack says there are no allergens.

## Python prototype

`src/`, `scripts/` hold the original desktop prototype (see `README-barcode-voice.md`). The phone app in `docs/` is the product.

## Visual model

- Trained with Ultralytics YOLOv8n for 50 epochs on the Roboflow Universe dataset *grocery-dataset-q9fj2* v5 (25 packaged-product classes, mostly Pakistani-market brands), licence **CC BY 4.0**: https://universe.roboflow.com/new-workspace-wfzw3/grocery-dataset-q9fj2/dataset/5
- Validation mAP50 0.995 / mAP50-95 0.90 on that dataset's own validation split. These numbers come from the same dataset, so they are optimistic; photos of real shelves and Indian packs are the real test. On Indian packs outside the 25 classes the model gives confident wrong answers (for example Haldiram's Taka-Tak was labelled Kolson Slanty Jalapeno at 86%), which is why the app cross-checks it.
- To use a new model: train, then `yolo export model=best.pt format=onnx imgsz=640 opset=12`, copy the `.onnx` to `docs/model/grocery.onnx`, and update `docs/model/labels.json` (class names and the keywords the OCR cross-check looks for).
- To cover Indian products: photograph each pack (front and back, varied light and angles, 40+ photos per product), add images of *other* packs as negatives, label in Roboflow, retrain, export as above.

## Credits

- Visual model dataset: Roboflow Universe *grocery-dataset-q9fj2* (CC BY 4.0), see above.
- Text reader: PaddleOCR PP-OCRv4 (Apache-2.0), ONNX export from the `@gutenye/ocr-models` package (MIT); Tesseract.js (Apache-2.0) as fallback.
- Barcode: zxing-wasm (MIT). Inference: onnxruntime-web (MIT). Product data: Open Food Facts (ODbL).
