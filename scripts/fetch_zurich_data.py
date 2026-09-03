"""Prepare the offline GridPath Zurich-region scenario from OpenStreetMap.

This script is intentionally the only component that contacts Overpass. The API
serves its committed output and never performs external spatial-data requests.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import geopandas as gpd
import osmnx as ox
import pandas as pd
from pyproj import Transformer
from shapely.geometry import Point, box, mapping
from shapely.validation import make_valid

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PROCESSED_DIR = PROJECT_ROOT / "data" / "processed"
SCENARIO_PATH = PROCESSED_DIR / "zurich_gridpath_scenario.geojson"
MANIFEST_PATH = PROCESSED_DIR / "zurich_gridpath_manifest.json"
ROADS_PATH = PROCESSED_DIR / "zurich_gridpath_roads.json"
ANALYSIS_CRS = "EPSG:2056"
EXCHANGE_CRS = "EPSG:4326"
SCENARIO_ID = "zurich-dietikon-urdorf-v1"
CENTRE = (47.397, 8.414)
HALF_SIZE_M = 600
TAGS: dict[str, Any] = {
    "building": True,
    "power": ["substation", "line"],
    "boundary": "protected_area",
    "leisure": ["nature_reserve", "park"],
    "landuse": ["forest", "grass", "meadow", "recreation_ground"],
    "natural": ["wood", "water", "wetland"],
    "waterway": True,
}
PEDESTRIAN_ONLY_HIGHWAYS = {"footway", "path", "steps", "pedestrian", "bridleway", "corridor"}


def study_area_geometry() -> tuple[object, tuple[float, float, float, float]]:
    """Build a 1.44 km2 square in metric CRS, then return WGS84 geometry/bounds."""
    to_metric = Transformer.from_crs(EXCHANGE_CRS, ANALYSIS_CRS, always_xy=True)
    to_wgs84 = Transformer.from_crs(ANALYSIS_CRS, EXCHANGE_CRS, always_xy=True)
    x, y = to_metric.transform(CENTRE[1], CENTRE[0])
    metric_area = box(x - HALF_SIZE_M, y - HALF_SIZE_M, x + HALF_SIZE_M, y + HALF_SIZE_M)
    wgs84_area = gpd.GeoSeries([metric_area], crs=ANALYSIS_CRS).to_crs(EXCHANGE_CRS).iloc[0]
    return wgs84_area, tuple(wgs84_area.bounds)


def _safe_geometry(geometry: object) -> object | None:
    if geometry is None or geometry.is_empty:
        return None
    if not geometry.is_valid:
        geometry = make_valid(geometry)
    return None if geometry.is_empty else geometry


def classify_features(features: gpd.GeoDataFrame, study_area: object) -> dict[str, gpd.GeoDataFrame]:
    """Classify OSM union-query results by their actual tags, not query membership."""
    metric_area = gpd.GeoSeries([study_area], crs=EXCHANGE_CRS).to_crs(ANALYSIS_CRS).iloc[0]
    frame = features.to_crs(ANALYSIS_CRS).copy()
    frame["geometry"] = frame.geometry.map(_safe_geometry)
    frame = frame[frame.geometry.notna() & frame.geometry.intersects(metric_area)].copy()
    frame["geometry"] = frame.geometry.intersection(metric_area)
    frame = frame[frame.geometry.map(_safe_geometry).notna()].copy()

    def tagged(column: str, values: set[str] | None = None) -> gpd.GeoDataFrame:
        if column not in frame:
            return frame.iloc[0:0].copy()
        mask = frame[column].notna()
        if values is not None:
            mask &= frame[column].astype(str).isin(values)
        return frame.loc[mask].copy()

    protected = tagged("boundary", {"protected_area"})
    nature_reserves = tagged("leisure", {"nature_reserve"})
    statutory = gpd.GeoDataFrame(
        pd.concat([protected, nature_reserves]).drop_duplicates(), crs=ANALYSIS_CRS
    )
    environmental = gpd.GeoDataFrame(
        pd.concat(
            [
                tagged("landuse", {"forest", "grass", "meadow", "recreation_ground"}),
                tagged("leisure", {"park"}),
                tagged("natural", {"wood", "wetland"}),
            ]
        ).drop_duplicates(),
        crs=ANALYSIS_CRS,
    )
    water = gpd.GeoDataFrame(
        pd.concat([tagged("natural", {"water"}), tagged("waterway")]).drop_duplicates(),
        crs=ANALYSIS_CRS,
    )
    return {
        "buildings": tagged("building"),
        "statutory_protected": statutory,
        "environmental_sensitivity": environmental,
        "water": water,
        "power_assets": tagged("power", {"substation", "line"}),
    }


def _properties(index: object, row: Any, layer: str) -> dict[str, str]:
    osm_type, osm_id = index if isinstance(index, tuple) else ("unknown", index)
    properties = {"layer": layer, "osm_type": str(osm_type), "osm_id": str(osm_id), "source": "OpenStreetMap"}
    for key in ("building", "power", "boundary", "leisure", "landuse", "natural", "waterway", "name"):
        value = row.get(key)
        if value is not None and not pd.isna(value):
            properties[key] = str(value)
    return properties


def _tag_value(value: Any) -> str:
    if isinstance(value, list):
        return ";".join(str(item) for item in value)
    return "" if value is None or pd.isna(value) else str(value)


def prepare_roads(study_area: object) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Persist a deterministic, routable OSM street graph for offline use."""
    graph = ox.graph_from_point(CENTRE, dist=750, network_type="all")
    metric_area = gpd.GeoSeries([study_area], crs=EXCHANGE_CRS).to_crs(ANALYSIS_CRS).iloc[0]
    nodes: dict[str, dict[str, float]] = {}
    edges: list[dict[str, Any]] = []
    street_features: list[dict[str, Any]] = []
    for source, target, key, data in graph.edges(keys=True, data=True):
        highway = _tag_value(data.get("highway"))
        if highway in PEDESTRIAN_ONLY_HIGHWAYS:
            continue
        geometry = data.get("geometry")
        if geometry is None:
            geometry = gpd.GeoSeries(
                [Point(graph.nodes[source]["x"], graph.nodes[source]["y"]), Point(graph.nodes[target]["x"], graph.nodes[target]["y"])]
            ).unary_union
        if geometry.geom_type == "MultiPoint":
            geometry = gpd.GeoSeries([geometry]).unary_union.convex_hull
        metric_geometry = gpd.GeoSeries([geometry], crs=EXCHANGE_CRS).to_crs(ANALYSIS_CRS).iloc[0]
        if not metric_area.buffer(5).covers(metric_geometry):
            continue
        edge_id = f"{source}:{target}:{key}"
        properties = {
            "layer": "road_network",
            "edge_id": edge_id,
            "source": str(source),
            "target": str(target),
            "osm_id": _tag_value(data.get("osmid")),
            "highway": highway,
            "access": _tag_value(data.get("access")),
            "bridge": _tag_value(data.get("bridge")),
            "tunnel": _tag_value(data.get("tunnel")),
            "length_m": round(float(data.get("length", metric_geometry.length)), 2),
        }
        edges.append({**properties, "geometry": mapping(geometry)})
        street_features.append({"type": "Feature", "properties": properties, "geometry": mapping(geometry)})
        for node in (source, target):
            nodes[str(node)] = {"longitude": graph.nodes[node]["x"], "latitude": graph.nodes[node]["y"]}
    return street_features, {"source": "OpenStreetMap street network via OSMnx / Overpass", "retrieved_at": datetime.now(UTC).date().isoformat(), "nodes": nodes, "edges": edges}


def geojson_features(layers: dict[str, gpd.GeoDataFrame], study_area: object, street_features: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    result = [{"type": "Feature", "properties": {"layer": "study_area", "source": "GridPath prepared study area"}, "geometry": mapping(study_area)}]
    for layer, frame in layers.items():
        for index, row in frame.to_crs(EXCHANGE_CRS).iterrows():
            result.append({"type": "Feature", "properties": _properties(index, row, layer), "geometry": mapping(row.geometry)})
    result.extend(street_features or [])
    endpoints = [
        ("grid_connection", "Representative grid connection", (8.4086, 47.3948), "synthetic"),
        ("proposed_development", "Proposed development", (8.415859, 47.391835), "synthetic"),
    ]
    for endpoint_id, label, coordinates, provenance in endpoints:
        result.append({"type": "Feature", "properties": {"layer": "endpoints", "endpoint_id": endpoint_id, "label": label, "provenance": provenance, "source": "GridPath synthetic demonstrative endpoint"}, "geometry": mapping(Point(coordinates))})
    return result


def build_manifest(bounds: tuple[float, float, float, float], layers: dict[str, gpd.GeoDataFrame], street_features: list[dict[str, Any]], retrieved_at: str) -> dict[str, Any]:
    counts = {"study_area": 1, **{name: len(frame) for name, frame in layers.items()}, "street_network": len(street_features), "endpoints": 2}
    return {
        "scenario_id": SCENARIO_ID,
        "scenario_name": "Dietikon/Urdorf peri-urban GridPath study area",
        "selected_location": "Dietikon/Urdorf, Zurich region, Switzerland",
        "bounds": {"west": bounds[0], "south": bounds[1], "east": bounds[2], "north": bounds[3]},
        "source": "OpenStreetMap via OSMnx / Overpass",
        "retrieved_at": retrieved_at,
        "source_crs": EXCHANGE_CRS,
        "analysis_crs": ANALYSIS_CRS,
        "layer_counts": counts,
        "statutory_protected_present": counts["statutory_protected"] > 0,
        "limitations": [
            "OpenStreetMap coverage is volunteered and may be incomplete or outdated.",
            "No statutory protected-area feature was mapped in this prepared study area." if counts["statutory_protected"] == 0 else "Mapped protected-area tags are not an official environmental register.",
            "Forest, park, wetland, and water features are environmental-sensitivity proxies, not statutory determinations.",
            "Both endpoints are synthetic demonstrative locations; no proposed project is implied.",
            "Mapped streets are preliminary accessible routing corridors, not verified utility easements or proof of public ownership.",
        ],
        "disclaimer": "Planning prototype only. Not a regulatory-compliance determination or construction-ready alignment.",
        "endpoints": [
            {"id": "grid_connection", "label": "Representative grid connection", "coordinates": [8.4086, 47.3948], "provenance": "synthetic"},
            {"id": "proposed_development", "label": "Proposed development", "coordinates": [8.415859, 47.391835], "provenance": "synthetic"},
        ],
    }


def main() -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    ox.settings.use_cache = True
    ox.settings.requests_timeout = 120
    study_area, bounds = study_area_geometry()
    raw_features = ox.features_from_point(CENTRE, tags=TAGS, dist=HALF_SIZE_M)
    layers = classify_features(raw_features, study_area)
    retrieved_at = datetime.now(UTC).date().isoformat()
    street_features, roads = prepare_roads(study_area)
    scenario = {"type": "FeatureCollection", "features": geojson_features(layers, study_area, street_features)}
    manifest = build_manifest(bounds, layers, street_features, retrieved_at)
    SCENARIO_PATH.write_text(json.dumps(scenario, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    ROADS_PATH.write_text(json.dumps(roads, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps(manifest["layer_counts"], indent=2))


if __name__ == "__main__":
    main()
