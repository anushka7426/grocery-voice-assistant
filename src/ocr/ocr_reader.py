import csv
import io
import re
import subprocess
from pathlib import Path

import cv2


def _run_ocr(image, page_mode: int):
    """Return readable-looking words with their Tesseract confidence."""
    success, encoded = cv2.imencode(".png", image)
    if not success:
        return [], 0.0

    result = subprocess.run(
        [
            "tesseract", "stdin", "stdout",
            "-l", "eng",
            "--psm", str(page_mode),
            "tsv",
        ],
        input=encoded.tobytes(),
        capture_output=True,
        timeout=20,
        check=False,
    )

    if result.returncode != 0:
        return [], 0.0

    reader = csv.DictReader(
        io.StringIO(result.stdout.decode("utf-8", errors="replace")),
        delimiter="\t",
    )

    lines = {}

    for row in reader:
        if row.get("level") != "5":
            continue

        word = row.get("text", "").strip()

        try:
            confidence = float(row.get("conf", "-1"))
            left = int(row.get("left", "0"))
            top = int(row.get("top", "0"))
            block = int(row.get("block_num", "0"))
            paragraph = int(row.get("par_num", "0"))
            line = int(row.get("line_num", "0"))
        except ValueError:
            continue

        # Be conservative: discard low-confidence words.
        if confidence < 65:
            continue

        # Ignore punctuation, isolated letters, and pure numbers.
        cleaned = re.sub(r"[^A-Za-z0-9&'-]", "", word)
        letters = sum(character.isalpha() for character in cleaned)

        if letters < 3:
            continue

        if not cleaned:
            continue

        key = (block, paragraph, line)
        lines.setdefault(key, []).append(
            (left, top, cleaned, confidence)
        )

    if not lines:
        return [], 0.0

    ordered_lines = sorted(
        lines.values(),
        key=lambda items: min(item[1] for item in items),
    )

    words = []
    for items in ordered_lines:
        items.sort(key=lambda item: item[0])
        words.extend((item[2], item[3]) for item in items)

    average_confidence = sum(
        confidence for _, confidence in words
    ) / len(words)

    return words, average_confidence


def read_package_text(image_path: str | Path) -> str:
    """
    Try the original image, a package crop, and rotated/enhanced versions.
    Returned text is unverified and must not be treated as product identity.
    """
    path = Path(image_path)

    if not path.is_file():
        raise FileNotFoundError(f"Image not found: {path}")

    image = cv2.imread(str(path))
    if image is None:
        raise ValueError(f"Could not read image: {path}")

    height, width = image.shape[:2]

    # The package occupies mostly the lower portion of this sample photo.
    package = image[int(height * 0.30):, :int(width * 0.95)]

    candidates = []

    for region in (image, package):
        for orientation in (region, cv2.rotate(region, cv2.ROTATE_180)):
            gray = cv2.cvtColor(
                orientation, cv2.COLOR_BGR2GRAY
            )

            enlarged = cv2.resize(
                gray, None, fx=1.5, fy=1.5,
                interpolation=cv2.INTER_CUBIC,
            )

            contrast = cv2.createCLAHE(
                clipLimit=2.0,
                tileGridSize=(8, 8),
            ).apply(enlarged)

            _, binary = cv2.threshold(
                contrast, 0, 255,
                cv2.THRESH_BINARY + cv2.THRESH_OTSU,
            )

            for variant in (enlarged, contrast, binary):
                for page_mode in (6, 11):
                    words, average_confidence = _run_ocr(
                        variant, page_mode
                    )

                    if words:
                        # Prefer several readable words over isolated text.
                        score = len(words) * average_confidence
                        candidates.append(
                            (score, words)
                        )

    if not candidates:
        return ""

    _, best_words = max(candidates, key=lambda item: item[0])
    return " ".join(word for word, _ in best_words)
