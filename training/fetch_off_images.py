"""Download product photos from Open Food Facts (CC-BY-SA, official API) for build_refs.py.

    python training/fetch_off_images.py --barcodes 8901058017687 8901063368521
    python training/fetch_off_images.py --from-json docs/data/products-in.json my-products.json
    python training/fetch_off_images.py --india 300          # most-scanned Indian products

Output (input for training/build_refs.py):
    photos/<barcode>/off_000.jpg ...
    photos/products.json         {"<barcode>": {"name","brand","quantity"}}

Open Food Facts asks API users to send a descriptive User-Agent and to be gentle;
this script waits between requests. Images are CC-BY-SA: keep the attribution if
you share them, and do not commit them to the app repository.
Run it on your own computer (the cloud sandbox cannot reach the site).
"""
import argparse, json, time
from pathlib import Path
import requests

UA = {"User-Agent": "GroceryVoiceAssistant/1.0 (student project)"}
HOST = "https://world.openfoodfacts.org"
FIELDS = "code,product_name,brands,quantity,image_front_url,image_front_small_url,selected_images"

p = argparse.ArgumentParser()
p.add_argument("--barcodes", nargs="*", default=[])
p.add_argument("--from-json", nargs="*", default=[], help="json files shaped like {'products': {barcode: {...}}}")
p.add_argument("--india", type=int, default=0, help="also fetch N popular products sold in India")
p.add_argument("--out", default="photos")
p.add_argument("--host", default=HOST)
p.add_argument("--delay", type=float, default=0.7)
a = p.parse_args()


def get(url, **kw):
    for i in range(3):
        try:
            r = requests.get(url, headers=UA, timeout=30, **kw)
            if r.status_code == 200:
                return r
            if r.status_code in (429, 503):
                time.sleep(5 * (i + 1))
            else:
                return None
        except requests.RequestException:
            time.sleep(2)
    return None


def front_urls(prod):
    """Front-of-pack image urls, best first (all languages, no duplicates)."""
    urls = []
    for k in ("image_front_url",):
        if prod.get(k):
            urls.append(prod[k])
    front = (prod.get("selected_images") or {}).get("front", {}).get("display", {}) or {}
    for u in front.values():
        if u and u not in urls:
            urls.append(u)
    return urls


codes = list(a.barcodes)
for f in a.from_json:
    codes += list(json.loads(Path(f).read_text()).get("products", {}))

found = {}
if a.india:
    page = 1
    while len(found) < a.india:
        r = get(f"{a.host}/api/v2/search", params={"countries_tags_en": "india", "sort_by": "popularity_key",
                                                  "fields": FIELDS, "page_size": 100, "page": page})
        items = (r.json().get("products") if r else None) or []
        if not items:
            break
        for it in items:
            if it.get("code") and front_urls(it):
                found[it["code"]] = it
        page += 1
        time.sleep(a.delay)
    print(f"{len(found)} Indian products listed")

out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
meta_path = out / "products.json"
meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
saved = 0
for code in dict.fromkeys(codes + list(found)):
    prod = found.get(code)
    if prod is None:
        r = get(f"{a.host}/api/v2/product/{code}.json", params={"fields": FIELDS})
        prod = (r.json().get("product") if r else None) or {}
        time.sleep(a.delay)
    urls = front_urls(prod)[:3]
    if not urls:
        print(f"{code}: no front image on Open Food Facts"); continue
    d = out / code; d.mkdir(exist_ok=True)
    n = 0
    for u in urls:
        img = get(u)
        if img is None:
            continue
        (d / f"off_{n:03d}.jpg").write_bytes(img.content); n += 1
        time.sleep(a.delay)
    if n:
        meta[code] = {"name": prod.get("product_name") or code, "brand": (prod.get("brands") or "").split(",")[0].strip(),
                      "quantity": prod.get("quantity") or "", **{k: v for k, v in meta.get(code, {}).items() if k in ("mrp", "diet")}}
        saved += 1
        print(f"{code}: {n} image(s) - {meta[code]['name']}")
meta_path.write_text(json.dumps(meta, indent=1, ensure_ascii=False))
print(f"{saved} products saved in {out}/. Next: python training/build_refs.py --photos {out} --augment 3")
