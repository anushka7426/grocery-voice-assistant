import json
from pathlib import Path

import requests


DATABASE_PATH = Path(__file__).with_name("products.json")
OPEN_FOOD_FACTS_URL = (
    "https://world.openfoodfacts.org/api/v2/product/{}.json"
)


def _load_local_product(barcode: str):
    """Search the local JSON database."""
    try:
        with DATABASE_PATH.open("r", encoding="utf-8") as file:
            database = json.load(file)

        product = database.get("products", {}).get(barcode)

        if product is not None:
            result = dict(product)
            result.setdefault("source", "local database")
            return result

    except (OSError, json.JSONDecodeError) as exc:
        print(f"Could not read local product database: {exc}")

    return None


def _load_online_product(barcode: str):
    """Look up a product online, handling missing records separately."""
    try:
        response = requests.get(
            OPEN_FOOD_FACTS_URL.format(barcode),
            headers={
                "User-Agent": "AccessibleGroceryAssistant/1.0"
            },
            timeout=10,
        )

        # A missing record is not the same as a network failure.
        if response.status_code == 404:
            return None

        response.raise_for_status()
        data = response.json()

    except (requests.RequestException, ValueError) as exc:
        print(f"Online product service unavailable: {exc}")
        return None

    if data.get("status") != 1:
        return None

    product = data.get("product", {})

    return {
        "name": product.get("product_name") or "Unknown product",
        "brand": product.get("brands", ""),
        "quantity": product.get("quantity", ""),
        "ingredients": product.get("ingredients_text", ""),
        "allergens": product.get("allergens", ""),
        "source": "Open Food Facts",
    }


def lookup_product(barcode: str, use_online: bool = True):
    """Search locally first, then optionally use Open Food Facts."""
    barcode = str(barcode).strip()

    if not barcode:
        return None

    product = _load_local_product(barcode)

    if product is not None:
        return product

    if not use_online:
        return None

    return _load_online_product(barcode)
