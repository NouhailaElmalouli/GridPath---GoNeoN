"""Request-local endpoint validation and edge snapping for the prepared scenario."""
# ruff: noqa: E501

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from shapely.geometry import Point, shape
from shapely.ops import unary_union

from app.planning import PlanningError, _export
from app.road_graph import (
    EdgeSnap,
    RoadEdge,
    metric,
    snap_endpoint,
    snap_to_eligible_edge,
    split_edges_at_snaps,
)
from app.schemas import PlanRequest

MAX_ENDPOINT_DISTANCE_M = 1000.0
MAX_SNAP_DISTANCE_M = 75.0


@dataclass(frozen=True)
class EndpointSelection:
    points: dict[str, Point]
    snapped_points: dict[str, Point]
    snapped_nodes: dict[str, str]
    snapped_edge_ids: dict[str, str]
    connector_distances_m: dict[str, float]
    direct_distance_m: float
    endpoint_mode: str
    routing_edges: list[RoadEdge]


def _fail(code: str, message: str, endpoint_id: str, **measurements: float) -> None:
    raise PlanningError(code, message, {"endpoint_id": endpoint_id, **measurements})


def _point_from_request(request: PlanRequest, endpoint_id: str, defaults: dict[str, Point]) -> tuple[Point, bool]:
    supplied = getattr(request, endpoint_id)
    if supplied is None:
        return defaults[endpoint_id], False
    return metric(Point(supplied.coordinates)), True


def resolve_endpoints(features: list[dict[str, Any]], request: PlanRequest, edges: list[RoadEdge]) -> EndpointSelection:
    """Validate custom points and create an isolated edge-split routing graph."""
    layers: dict[str, list[Any]] = {}
    defaults: dict[str, Point] = {}
    for feature in features:
        properties = feature["properties"]
        geometry = metric(shape(feature["geometry"]))
        if properties["layer"] == "endpoints":
            defaults[properties["endpoint_id"]] = geometry
        else:
            layers.setdefault(properties["layer"], []).append(geometry)
    study_area = unary_union(layers.get("study_area", []))
    water = unary_union(layers.get("water", []))
    protected = unary_union(layers.get("statutory_protected", []))
    points: dict[str, Point] = {}
    supplied_ids: set[str] = set()
    for endpoint_id in ("grid_connection", "proposed_development"):
        point, supplied = _point_from_request(request, endpoint_id, defaults)
        points[endpoint_id] = point
        if supplied:
            supplied_ids.add(endpoint_id)
        if supplied and not study_area.covers(point):
            _fail("ENDPOINT_OUTSIDE_STUDY_AREA", "Selected endpoint is outside the prepared study area.", endpoint_id)
        if supplied and not water.is_empty and water.covers(point):
            _fail("ENDPOINT_IN_WATER", "Selected endpoint is inside a water feature.", endpoint_id)
        if supplied and not protected.is_empty and protected.covers(point):
            _fail("ENDPOINT_IN_STATUTORY_EXCLUSION", "Selected endpoint is inside a statutory hard exclusion.", endpoint_id)
    direct_distance = points["grid_connection"].distance(points["proposed_development"])
    if direct_distance > MAX_ENDPOINT_DISTANCE_M + 1e-6:
        raise PlanningError(
            "ENDPOINT_DISTANCE_EXCEEDED",
            "Selected points are more than 1 km apart. Choose a closer endpoint.",
            {"calculated_distance_m": round(direct_distance, 3), "threshold_m": MAX_ENDPOINT_DISTANCE_M},
        )
    if not supplied_ids:
        start_id, start, start_distance = snap_endpoint(points["grid_connection"], edges)
        end_id, end, end_distance = snap_endpoint(points["proposed_development"], edges)
        return EndpointSelection(
            points, {"grid_connection": start, "proposed_development": end},
            {"grid_connection": start_id, "proposed_development": end_id},
            {"grid_connection": start_id, "proposed_development": end_id},
            {"grid_connection": start_distance, "proposed_development": end_distance},
            direct_distance, "demo", edges,
        )
    snaps: list[EdgeSnap] = []
    snapped_points: dict[str, Point] = {}
    snapped_nodes: dict[str, str] = {}
    snapped_edge_ids: dict[str, str] = {}
    connector_distances: dict[str, float] = {}
    for endpoint_id, point in points.items():
        if endpoint_id not in supplied_ids:
            node_id, snapped, distance_m = snap_endpoint(point, edges)
            snapped_points[endpoint_id] = snapped
            snapped_nodes[endpoint_id] = node_id
            snapped_edge_ids[endpoint_id] = node_id
            connector_distances[endpoint_id] = distance_m
            continue
        snap = snap_to_eligible_edge(endpoint_id, point, edges)
        if snap.distance_m > MAX_SNAP_DISTANCE_M:
            _fail(
                "NO_NEARBY_ROUTABLE_STREET",
                "Selected endpoint is more than 75 m from an eligible routable street corridor.",
                endpoint_id, calculated_distance_m=round(snap.distance_m, 3), threshold_m=MAX_SNAP_DISTANCE_M,
        )
        snaps.append(snap)
    routing_edges, virtual_node_ids = split_edges_at_snaps(edges, snaps)
    snap_by_endpoint = {snap.endpoint_id: snap for snap in snaps}
    for endpoint_id in supplied_ids:
        snapped_points[endpoint_id] = snap_by_endpoint[endpoint_id].point
        snapped_nodes[endpoint_id] = virtual_node_ids[endpoint_id]
        snapped_edge_ids[endpoint_id] = snap_by_endpoint[endpoint_id].edge_id
        connector_distances[endpoint_id] = snap_by_endpoint[endpoint_id].distance_m
    return EndpointSelection(
        points=points,
        snapped_points=snapped_points,
        snapped_nodes=snapped_nodes,
        snapped_edge_ids=snapped_edge_ids,
        connector_distances_m=connector_distances,
        direct_distance_m=direct_distance,
        endpoint_mode="user_selected",
        routing_edges=routing_edges,
    )


def response_endpoint_fields(selection: EndpointSelection) -> dict[str, object]:
    return {
        "selected_endpoints": {endpoint_id: _export(point) for endpoint_id, point in selection.points.items()},
        "snapped_road_points": {endpoint_id: _export(point) for endpoint_id, point in selection.snapped_points.items()},
        "straight_line_endpoint_distance_m": round(selection.direct_distance_m, 1),
        "connector_lengths_m": {endpoint_id: round(value, 1) for endpoint_id, value in selection.connector_distances_m.items()},
        "snapped_osm_edge_ids": selection.snapped_edge_ids,
        "endpoint_mode": selection.endpoint_mode,
    }
