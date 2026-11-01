import argparse
import sys
from pathlib import Path

# Add the project root so imports from src work.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.ocr.ocr_reader import read_package_text


def main():
    parser = argparse.ArgumentParser(
        description="Extract text from a grocery product image."
    )
    parser.add_argument("image", help="Path to a grocery product image")
    args = parser.parse_args()

    try:
        text = read_package_text(args.image)

        if text:
            print("Extracted text (UNVERIFIED):")
            print(text)
        else:
            print("No readable text detected.")

    except (FileNotFoundError, ValueError, RuntimeError) as exc:
        print(f"OCR error: {exc}")
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
