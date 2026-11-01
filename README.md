# Grocery Voice Assistant

A phone web app that helps blind and low-vision shoppers identify Indian grocery products. Point the camera at a pack: it finds the barcode, looks the product up, and **speaks** the result. It also reads printed label text (MRP, best-before, pack size) aloud.

**Use it:** open the GitHub Pages link on a phone (Chrome on Android recommended), tap *Start scanning*, then use *Add to Home screen* to install it. Works offline after the first load.

## How it works

1. **Barcode** - live camera, native phone detector plus zxing (WebAssembly). Every code must pass the check digit and then be re-read from zoomed crops; a code is spoken only when the re-reads agree.
2. **Lookup (offline first)** - products you taught the app, then `docs/data/products-in.json`, then results cached from earlier scans, then Open Food Facts when online.
3. **Label reader** - on-device OCR (Tesseract) pulls out MRP, net quantity and best-before and tries to match known products.
4. **Voice** - the phone's speech engine; follow-up questions (ingredients, allergens, nutrition, vegetarian) by button or voice.

Missing data is always reported as "not available", never as "none" (important for allergens).

## Run locally

```bash
cd docs
python3 -m http.server 8000     # then open http://localhost:8000 (camera works on localhost)
```

The camera needs HTTPS on a real phone: publish with GitHub Pages (Settings > Pages > Branch `main`, folder `/docs`).

## Add products

Edit `docs/data/products-in.json` (only barcodes you verified on a real pack). Products taught on a phone are stored on that phone.

## Python prototype

`src/`, `scripts/` hold the original desktop prototype (see `README-barcode-voice.md`). The phone app in `docs/` is the product.
