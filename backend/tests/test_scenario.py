import importlib.util
import json
from pathlib import Path

import geopandas as gpd
import pandas as pd
from fastapi.testclient import TestClient
from shapely.geometry import Polygon, shape

from app.api.scenario import get_scenario_repository
from app.main import app
from app.scenario_repository import ScenarioRepository

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = PROJECT_ROOT / "scripts" / "fetch_zurich_data.py"
spec = importlib.util.spec_from_file_location("fetch_zurich_data", SCRIPT_PATH)
assert spec and spec.loader
pipeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipeline)


def test_classification_repairs_invalid_geometry_and_exports_wgs84() -> None:
    study_area, _ = pipeline.study_area_geometry()
    invalid_building = Polygon([(8.41, 47.395), (8.415, 47.4), (8.415, 47.395), (8.41, 47.4)])
    frame = gpd.GeoDataFrame(
        {
            "building": ["yes"],
            "power": [None],
            "boundary": [None],
            "leisure": [None],
            "landuse": [None],
            "natural": [None],
            "waterway": [None],
        },
        geometry=[invalid_building],
        crs="EPSG:4326",
        index=pd.MultiIndex.from_tuples([("way", 1)]),
    )
    layers = pipeline.classify_features(frame, study_area)
    assert len(layers["buildings"]) == 1
    features = pipeline.geojson_features(layers, study_area)
    building = next(
        feature for feature in features if feature["properties"]["layer"] == "buildings"
    )
    assert building["properties"]["osm_id"] == "1"
    assert 8 < shape(building["geometry"]).bounds[0] < 9


def test_manifest_contract_and_local_scenario_response() -> None:
    repository = ScenarioRepository()
    response = repository.load()
    assert response.metadata.source == "OpenStreetMap via OSMnx / Overpass"
    assert response.metadata.endpoints[0].provenance == "synthetic"
    assert set(response.metadata.layer_counts) == {
        "study_area",
        "buildings",
        "statutory_protected",
        "environmental_sensitivity",
        "water",
        "power_assets",
        "endpoints",
    }
    assert all(feature["properties"]["layer"] for feature in response.layers["features"])


def test_scenario_endpoint_shape() -> None:
    response = TestClient(app).get("/api/scenario")
    assert response.status_code == 200
    body = response.json()
    assert body["metadata"]["scenario_id"] == "zurich-dietikon-urdorf-v1"
    assert body["metadata"]["layer_counts"]["buildings"] > 0
    assert body["layers"]["type"] == "FeatureCollection"


def test_missing_scenario_returns_structured_error(tmp_path: Path) -> None:
    missing = ScenarioRepository(tmp_path / "scenario.geojson", tmp_path / "manifest.json")
    app.dependency_overrides[get_scenario_repository] = lambda: missing
    try:
        response = TestClient(app).get("/api/scenario")
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "scenario_unavailable"


def test_manifest_is_json_and_declares_no_mapped_statutory_areas() -> None:
    manifest_path = PROJECT_ROOT / "data/processed/zurich_gridpath_manifest.json"
    manifest = json.loads(manifest_path.read_text())
    assert manifest["statutory_protected_present"] is False
    assert manifest["layer_counts"]["statutory_protected"] == 0
