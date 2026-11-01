from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from pyzbar.pyzbar import decode as pyzbar_decode, ZBarSymbol

try:
    import zxingcpp
except ImportError:
    zxingcpp = None


@dataclass
class BarcodeResult:
    value: str
    barcode_type: str


_RETAIL = {"EAN13", "EAN8", "UPCA", "UPCE"}
_ZBAR_SYMBOLS = [
    ZBarSymbol.EAN13, ZBarSymbol.EAN8, ZBarSymbol.UPCA, ZBarSymbol.UPCE,
]


def _norm_type(name: str) -> str:
    name = str(name).upper().replace("BARCODEFORMAT.", "")
    return name.replace("-", "").replace("_", "")


def _unique(results):
    output, seen = [], set()
    for r in results:
        key = (r.value, r.barcode_type)
        if r.value and key not in seen:
            seen.add(key)
            output.append(r)
    return output


def _decode_one(image):
    results = []

    try:
        for item in pyzbar_decode(image, symbols=_ZBAR_SYMBOLS):
            value = item.data.decode("utf-8", errors="replace").strip()
            if value:
                results.append(BarcodeResult(value, _norm_type(item.type)))
    except Exception:
        pass

    if zxingcpp is not None:
        try:
            for item in zxingcpp.read_barcodes(image):
                value = str(item.text).strip()
                if value:
                    results.append(
                        BarcodeResult(value, _norm_type(item.format))
                    )
        except Exception:
            pass

    return _unique(results)


def _gtin_ok(result) -> bool:
    """Check digit validation for EAN-13, UPC-A and EAN-8."""
    code, kind = result.value, result.barcode_type
    if kind == "UPCE":
        return code.isdigit()
    if kind not in {"EAN13", "EAN8", "UPCA"} or not code.isdigit():
        return False
    if len(code) not in (8, 12, 13):
        return False
    digits = [int(c) for c in code]
    total = sum(
        d * (3 if i % 2 == 0 else 1)
        for i, d in enumerate(reversed(digits[:-1]))
    )
    return (10 - total % 10) % 10 == digits[-1]


def _is_retail_barcode(result):
    return result.barcode_type in _RETAIL and _gtin_ok(result)


def _variants(image):
    gray = (
        cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        if image.ndim == 3 else image.copy()
    )
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    blurred = cv2.GaussianBlur(gray, (0, 0), 2)
    sharpened = cv2.addWeighted(gray, 1.7, blurred, -0.7, 0)
    _, otsu = cv2.threshold(
        clahe, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
    )
    adaptive = cv2.adaptiveThreshold(
        clahe, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY, 31, 11,
    )

    bases = [
        image, gray, clahe, sharpened,
        otsu, cv2.bitwise_not(otsu),
        adaptive, cv2.bitwise_not(adaptive),
    ]

    for base in bases:
        yield base
        largest = max(base.shape[:2])
        if largest <= 1200:
            yield cv2.resize(base, None, fx=2, fy=2,
                             interpolation=cv2.INTER_CUBIC)
        if largest <= 500:
            yield cv2.resize(base, None, fx=3, fy=3,
                             interpolation=cv2.INTER_CUBIC)

    for base in (gray, clahe):
        yield cv2.rotate(base, cv2.ROTATE_90_CLOCKWISE)
        yield cv2.rotate(base, cv2.ROTATE_90_COUNTERCLOCKWISE)


def _localized_regions(image):
    """Find where the bars are and yield padded crops around them."""
    height, width = image.shape[:2]

    def padded(x, y, w, h, frac):
        pad = int(frac * max(w, h))
        return image[
            max(y - pad, 0):min(y + h + pad, height),
            max(x - pad, 0):min(x + w + pad, width),
        ]

    # 1) OpenCV's built-in detector (detection only)
    try:
        out = cv2.barcode_BarcodeDetector().detect(image)
        points = out[-1]
        if points is not None:
            for quad in np.asarray(points).reshape(-1, 4, 2):
                x, y, w, h = cv2.boundingRect(quad.astype(np.int32))
                crop = padded(x, y, w, h, 0.3)
                if crop.size:
                    yield crop
    except Exception:
        pass

    # 2) Gradient-based localisation
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=-1)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=-1)
    grad = cv2.convertScaleAbs(cv2.subtract(gx, gy))
    grad = cv2.blur(grad, (9, 9))
    _, mask = cv2.threshold(
        grad, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
    )
    mask = cv2.morphologyEx(
        mask, cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (31, 7)),
    )
    mask = cv2.dilate(cv2.erode(mask, None, iterations=4), None, iterations=4)

    contours, _ = cv2.findContours(
        mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    for c in sorted(contours, key=cv2.contourArea, reverse=True)[:3]:
        x, y, w, h = cv2.boundingRect(c)
        crop = padded(x, y, w, h, 0.15)
        if crop.size:
            yield crop


def _regions(image):
    height, width = image.shape[:2]

    yield from _localized_regions(image)
    yield image

    for start in (0.45, 0.55, 0.65, 0.72):
        y = int(start * height)
        if height - y >= 30:
            yield image[y:height, :]

    crop_w = max(1, int(width * 0.70))
    crop_h = max(1, int(height * 0.45))
    xs = sorted({0, int(0.15 * width), int(0.30 * width)})
    ys = sorted({0, int(0.30 * height), int(0.55 * height)})
    for y in ys:
        for x in xs:
            x2, y2 = min(width, x + crop_w), min(height, y + crop_h)
            if x2 > x and y2 > y:
                yield image[y:y2, x:x2]

    yield image[int(0.50 * height):height, int(0.25 * width):width]


MIN_VOTES = 2  # a value must decode from at least this many variants


def scan_barcodes(image_path: str | Path) -> list[BarcodeResult]:
    path = Path(image_path)
    if not path.is_file():
        raise FileNotFoundError(f"Image not found: {path}")

    image = cv2.imread(str(path))
    if image is None:
        raise ValueError(f"Could not read image: {path}")

    for region in _regions(image):
        votes = Counter()
        sample = {}
        for variant in _variants(region):
            for r in _decode_one(variant):
                if _is_retail_barcode(r):
                    votes[r.value] += 1
                    sample[r.value] = r

        confirmed = [v for v, n in votes.most_common() if n >= MIN_VOTES]
        if confirmed:
            return [sample[v] for v in confirmed]

    return []
