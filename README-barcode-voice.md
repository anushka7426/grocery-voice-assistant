# Barcode → Product Lookup → Voice Prototype

This module scans a product image, decodes visible barcodes, checks the local JSON database, optionally queries Open Food Facts, and reads the result aloud.

## 1. Install system dependencies in Ubuntu/WSL

```bash
sudo apt update
sudo apt install -y libzbar0 espeak-ng
```

If your existing virtual environment is active, install the Python packages into it:

```bash
cd ~/grocery_product
source yolov8-env/bin/activate
pip install -r requirements-barcode-voice.txt
```

Copy the files from this bundle into the matching locations in your existing `grocery_product` project. Do not replace your main `requirements.txt` unless you want to merge these dependencies into it.

## 2. Run a test

Use a real photo where the barcode is visible and in focus:

```bash
python scripts/test_pipeline.py test_images/product.jpg
```

Print the result without speech:

```bash
python scripts/test_pipeline.py test_images/product.jpg --no-speech
```

Offline-only lookup:

```bash
python scripts/test_pipeline.py test_images/product.jpg --offline --no-speech
```

Replace `test_images/product.jpg` with the path to your actual test image.

## 3. Add verified local product records

Edit `src/database/products.json`:

```json
{
  "products": {
    "REPLACE_WITH_REAL_BARCODE": {
      "name": "Product name",
      "brand": "Brand",
      "quantity": "Package size",
      "ingredients": "",
      "allergens": ""
    }
  }
}
```

Replace the example placeholder with a barcode number read from the actual product packaging and verified against the product. Do not invent barcode-to-product mappings.

## Notes and limitations

- Barcode decoding only works if the barcode is visible enough in the image. It does not recognise a product from its appearance; that is the role of your YOLO detector.
- Open Food Facts may not have every product or every field. Its data can be incomplete or user-contributed, so don't treat missing allergen/ingredient information as proof that a product is allergen-free.
- Online lookup requires an internet connection. `--offline` avoids network requests.
- The speech command is intended for Linux/WSL. Audio playback may not work in every WSL setup. If speech fails, use `--no-speech` to test scanning and lookup first.
- This is a Python prototype, not yet the Android app.
