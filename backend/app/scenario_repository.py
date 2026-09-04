"""Local, validated access to the prepared GridPath scenario files."""

from __future__ import annotations

import json
from pathlib import Path

from app.schemas import ScenarioMetadata, ScenarioResponse

LAYER_NAMES = {
    "study_area",
    "buildings",
    "statutory_protected",
    "environmental_sensitivity",
    "water",
    "power_assets",
    "road_network",
    "endpoints",
}
PROJECT_ROOT = Path(__file__).resolve().parents[1]


class ScenarioRepositoryError(Exception):
    """Raised when a prepared scenario is missing or has an invalid contract."""


class ScenarioRepository:
    def __init__(
        self, scenario_path: Path | None = None, manifest_path: Path | None = None
    ) -> None:
        data_directory = PROJECT_ROOT / "data" / "processed"
        self.scenario_path = scenario_path or data_directory / "zurich_gridpath_scenario.geojson"
        self.manifest_path = manifest_path or data_directory / "zurich_gridpath_manifest.json"

    def load(self) -> ScenarioResponse:
        try:
            scenario = json.loads(self.scenario_path.read_text(encoding="utf-8"))
            manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        except FileNotFoundError as error:
            raise ScenarioRepositoryError("Prepared scenario files are missing.") from error
        except json.JSONDecodeError as error:
            raise ScenarioRepositoryError(
                "Prepared scenario files contain invalid JSON."
            ) from error

        if scenario.get("type") != "FeatureCollection" or not isinstance(
            scenario.get("features"), list
        ):
            raise ScenarioRepositoryError("Prepared scenario GeoJSON must be a FeatureCollection.")
        for feature in scenario["features"]:
            layer = feature.get("properties", {}).get("layer")
            if feature.get("type") != "Feature" or layer not in LAYER_NAMES:
                raise ScenarioRepositoryError(
                    "Prepared scenario contains an invalid normalized layer."
                )
        try:
            metadata = ScenarioMetadata.model_validate(manifest)
        except ValueError as error:
            raise ScenarioRepositoryError(
                "Prepared scenario manifest does not match the contract."
            ) from error
        if set(metadata.layer_counts) != LAYER_NAMES:
            raise ScenarioRepositoryError("Prepared scenario manifest has unstable layer names.")
        return ScenarioResponse(metadata=metadata, layers=scenario)
