"""Deterministic, offline street-corridor opportunity screening."""
# ruff: noqa: E501, E701, E702

from __future__ import annotations

from typing import Any

from shapely.geometry import Polygon, shape
from shapely.ops import unary_union

from app.planning import PlanningError
from app.road_graph import load_road_edges, metric, undirected_edges


def _feature(geometry: Any, properties: dict[str, Any]) -> dict[str, Any]:
    from app.planning import _export
    return {"type": "Feature", "properties": properties, "geometry": _export(geometry)}


def screen_area(scenario_id: str, features: list[dict[str, Any]], request: Any) -> dict[str, Any]:
    if request.scenario_id != scenario_id:
        raise PlanningError("unknown_scenario", "The requested scenario ID does not match the prepared scenario.", {})
    study = next(shape(item["geometry"]) for item in features if item.get("properties", {}).get("layer") == "study_area")
    selected = study if request.area is None else Polygon(request.area.coordinates[0])
    if not selected.is_valid or selected.is_empty or not study.covers(selected):
        raise PlanningError("AREA_OUTSIDE_STUDY_AREA", "Selected area must be a valid polygon completely inside the prepared study area.", {})
    area = metric(selected)
    buildings = unary_union([metric(shape(item["geometry"])) for item in features if item.get("properties", {}).get("layer") == "buildings"])
    environment = unary_union([metric(shape(item["geometry"])) for item in features if item.get("properties", {}).get("layer") == "environmental_sensitivity"])
    water = unary_union([metric(shape(item["geometry"])) for item in features if item.get("properties", {}).get("layer") == "water"])
    summary: dict[str, dict[str, float | int]] = {name: {"count": 0, "length_m": 0.0} for name in ("preferred", "viable", "constrained", "excluded")}
    impacts: dict[str, float | int] = {"building_conflicts": 0, "environmental_overlap_m2": 0.0, "water_interactions": 0}
    screened: list[dict[str, Any]] = []
    for edge in undirected_edges(load_road_edges(features)):
        if not area.intersects(edge.geometry):
            continue
        geometry = edge.geometry.intersection(area)
        if geometry.is_empty or geometry.length < 0.5:
            continue
        corridor = geometry.buffer(request.right_of_way_width_m / 2)
        building_conflict = corridor.intersects(buildings)
        environmental_overlap = corridor.intersection(environment).area if not environment.is_empty else 0.0
        water_interaction = geometry.intersects(water)
        restricted_access = edge.access.lower() in {"no", "private", "destination"}
        major = edge.highway in {"primary", "trunk", "motorway"}
        penalties = (45 if building_conflict else 0) + min(25, environmental_overlap / 4) + (15 if water_interaction else 0) + (12 if edge.bridge else 0) + (12 if edge.tunnel else 0) + (20 if restricted_access else 0) + (8 if major else 0)
        score = round(max(0, 100 - penalties), 1)
        category = "excluded" if building_conflict or restricted_access else "preferred" if score >= 85 else "viable" if score >= 60 else "constrained"
        concerns = []
        if building_conflict: concerns.append("right-of-way intersects a mapped building")
        if environmental_overlap: concerns.append(f"{environmental_overlap:.1f} m² environmental overlap")
        if water_interaction: concerns.append("water interaction")
        if edge.bridge: concerns.append("bridge structure")
        if edge.tunnel: concerns.append("tunnel structure")
        if restricted_access: concerns.append("restricted OSM access")
        if major: concerns.append("major-road context")
        reason = "No measured hard conflict; low constraint corridor." if not concerns else "; ".join(concerns) + "."
        props = {"edge_id": edge.original_edge_id or edge.edge_id, "osm_way_id": edge.original_edge_id or edge.edge_id, "road_class": edge.highway, "length_m": round(geometry.length, 1), "building_conflicts": int(building_conflict), "environmental_overlap_m2": round(environmental_overlap, 1), "water_interaction": water_interaction, "bridge": edge.bridge, "tunnel": edge.tunnel, "access_suitable": not restricted_access, "score": score, "category": category, "reason": reason}
        screened.append(_feature(geometry, props)); summary[category]["count"] += 1; summary[category]["length_m"] = round(float(summary[category]["length_m"]) + geometry.length, 1)
        impacts["building_conflicts"] += int(building_conflict); impacts["environmental_overlap_m2"] = round(float(impacts["environmental_overlap_m2"]) + environmental_overlap, 1); impacts["water_interactions"] += int(water_interaction)
    preferred = sorted((item for item in screened if item["properties"]["category"] in {"preferred", "viable"}), key=lambda item: (-item["properties"]["score"], -item["properties"]["length_m"], item["properties"]["edge_id"]))
    zones: list[dict[str, Any]] = []
    for feature in preferred:
        midpoint = shape(feature["geometry"]).interpolate(0.5, normalized=True)
        if all(metric(midpoint).distance(metric(shape(zone["geometry"]))) > 100 for zone in zones):
            zones.append(_feature(midpoint, {"rank": len(zones) + 1, **feature["properties"]}))
        if len(zones) == 3: break
    return {"selected_area": _feature(selected, {"kind": "screened_area"})["geometry"], "segments": {"type": "FeatureCollection", "features": screened}, "total_kilometres_screened": round(sum(float(item["properties"]["length_m"]) for item in screened) / 1000, 3), "category_summary": summary, "aggregated_impacts": impacts, "opportunity_zones": zones, "scoring_assumptions": ["Score starts at 100; mapped building conflict or restricted access excludes a segment.", "Environmental overlap, water, bridge, tunnel, major-road and access flags apply deterministic penalties.", "Preferred ≥85, viable ≥60, constrained <60; excluded has a hard screening concern."], "limitations": ["Street-corridor screening only; it does not establish electrical capacity, ownership, approval, or construction readiness.", "OSM attributes and prepared constraint layers are planning-prototype evidence."]}
