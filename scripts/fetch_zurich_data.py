"""Prepare the small Zürich demo scenario.

Tomorrow's first implementation task:
1. Select a compact AOI after inspecting OSM feature coverage.
2. Download buildings, water, green/protected areas with OSMnx.
3. Reproject to EPSG:2056 and classify hard/soft constraints.
4. Save normalized GeoJSON layers under data/processed.

Keep downloads outside the runtime request path.
"""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = PROJECT_ROOT / "data" / "raw"
PROCESSED_DIR = PROJECT_ROOT / "data" / "processed"


def main() -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    raise SystemExit("Dataset pipeline intentionally queued as tomorrow's first implementation task.")


if __name__ == "__main__":
    main()

