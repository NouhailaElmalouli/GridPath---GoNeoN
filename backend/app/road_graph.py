"""Validated offline OSM road graph utilities; never performs network requests."""
# ruff: noqa: E501

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import networkx as nx
from pyproj import Transformer
from shapely.geometry import LineString, Point, shape
from shapely.ops import substring, transform

WGS84_TO_METRIC = Transformer.from_crs("EPSG:4326", "EPSG:2056", always_xy=True)
PEDESTRIAN_ONLY = {"footway", "path", "steps", "pedestrian", "bridleway", "corridor"}


class RoadGraphError(ValueError):
    """Raised when prepared road-network records fail their contract."""


@dataclass(frozen=True)
class RoadEdge:
    edge_id: str
    source: str
    target: str
    geometry: LineString
    length_m: float
    highway: str
    access: str
    bridge: bool
    tunnel: bool
    original_edge_id: str | None = None


def metric(geometry: Any) -> Any:
    return transform(WGS84_TO_METRIC.transform, geometry)


def load_road_edges(features: list[dict[str, Any]]) -> list[RoadEdge]:
    edges: list[RoadEdge] = []
    identifiers: set[str] = set()
    for feature in features:
        properties = feature.get("properties", {})
        if properties.get("layer") != "road_network":
            continue
        required = (
            "edge_id", "source", "target", "length_m", "highway", "access", "bridge", "tunnel"
        )
        missing = [name for name in required if name not in properties]
        if missing:
            raise RoadGraphError(f"Road edge is missing required properties: {', '.join(missing)}")
        geometry = metric(shape(feature["geometry"]))
        if not isinstance(geometry, LineString) or not geometry.is_valid or geometry.length == 0:
            raise RoadGraphError(
                f"Road edge {properties['edge_id']} has invalid LineString geometry."
            )
        edge_id = str(properties["edge_id"])
        if edge_id in identifiers:
            raise RoadGraphError(f"Road edge {edge_id} is duplicated.")
        identifiers.add(edge_id)
        highway = str(properties["highway"])
        if highway in PEDESTRIAN_ONLY:
            continue
        bridge = str(properties["bridge"]).lower() not in {"", "no", "false", "0"}
        tunnel = str(properties["tunnel"]).lower() not in {"", "no", "false", "0"}
        edges.append(
            RoadEdge(
                edge_id, str(properties["source"]), str(properties["target"]), geometry,
                float(properties["length_m"]), highway, str(properties["access"]), bridge, tunnel,
            )
        )
    if not edges:
        raise RoadGraphError("Prepared scenario contains no eligible road-network edges.")
    return edges


def directed_graph(edges: list[RoadEdge], weights: dict[str, float] | None = None) -> nx.DiGraph:
    graph = nx.DiGraph()
    for edge in edges:
        weight = (weights or {}).get(edge.edge_id, edge.length_m)
        existing = graph.get_edge_data(edge.source, edge.target)
        if existing is None or weight < existing["weight"]:
            graph.add_edge(edge.source, edge.target, edge=edge, weight=weight)
    return graph


def undirected_edges(edges: list[RoadEdge]) -> list[RoadEdge]:
    """Collapse reciprocal OSM records while retaining one original record per street segment.

    Cable trenches may use either carriageway direction.  The prepared OSM graph
    can contain a reciprocal record for the same geometry, so a topology edge is
    keyed by unordered nodes plus its orientation-independent geometry.
    """
    unique: dict[tuple[str, str, tuple[tuple[float, float], ...]], RoadEdge] = {}
    for edge in edges:
        coordinates = tuple((round(x, 3), round(y, 3)) for x, y in edge.geometry.coords)
        canonical_geometry = min(coordinates, tuple(reversed(coordinates)))
        key = (*sorted((edge.source, edge.target)), canonical_geometry)
        current = unique.get(key)
        if current is None or (edge.length_m, edge.edge_id) < (current.length_m, current.edge_id):
            unique[key] = edge
    return sorted(unique.values(), key=lambda edge: edge.edge_id)


def undirected_graph(edges: list[RoadEdge], weights: dict[str, float] | None = None) -> nx.Graph:
    """Build the physical street topology used for underground-corridor planning."""
    graph = nx.Graph()
    for edge in undirected_edges(edges):
        weight = (weights or {}).get(edge.edge_id, edge.length_m)
        existing = graph.get_edge_data(edge.source, edge.target)
        if existing is None or (weight, edge.edge_id) < (
            existing["weight"], existing["edge"].edge_id
        ):
            graph.add_edge(edge.source, edge.target, edge=edge, weight=weight)
    return graph


def snap_endpoint(point: Point, edges: list[RoadEdge]) -> tuple[str, Point, float]:
    nodes: dict[str, Point] = {}
    for edge in edges:
        nodes.setdefault(edge.source, Point(edge.geometry.coords[0]))
        nodes.setdefault(edge.target, Point(edge.geometry.coords[-1]))
    node_id, node = min(nodes.items(), key=lambda item: item[1].distance(point))
    return node_id, node, point.distance(node)


@dataclass(frozen=True)
class EdgeSnap:
    endpoint_id: str
    edge_id: str
    point: Point
    distance_m: float
    position_m: float


def snap_to_eligible_edge(endpoint_id: str, point: Point, edges: list[RoadEdge]) -> EdgeSnap:
    """Find the closest point on an eligible physical edge, deterministically."""
    candidates = undirected_edges(edges)
    edge, position = min(
        ((candidate, candidate.geometry.project(point)) for candidate in candidates),
        key=lambda item: (item[0].geometry.interpolate(item[1]).distance(point), item[0].edge_id),
    )
    snapped = edge.geometry.interpolate(position)
    return EdgeSnap(endpoint_id, edge.edge_id, snapped, point.distance(snapped), position)


def split_edges_at_snaps(edges: list[RoadEdge], snaps: list[EdgeSnap]) -> tuple[list[RoadEdge], dict[str, str]]:
    """Split physical edge geometries at snapped points without mutating prepared data."""
    by_edge: dict[str, list[EdgeSnap]] = {}
    for snap in snaps:
        by_edge.setdefault(snap.edge_id, []).append(snap)
    result: list[RoadEdge] = []
    node_ids: dict[str, str] = {}
    for edge in undirected_edges(edges):
        edge_snaps = sorted(by_edge.get(edge.edge_id, []), key=lambda item: (item.position_m, item.endpoint_id))
        if not edge_snaps:
            result.append(edge)
            continue
        positions, nodes = [0.0], [edge.source]
        for snap in edge_snaps:
            if snap.position_m <= 1e-6:
                node_ids[snap.endpoint_id] = edge.source
            elif edge.geometry.length - snap.position_m <= 1e-6:
                node_ids[snap.endpoint_id] = edge.target
            else:
                node_id = f"virtual:{snap.endpoint_id}"
                node_ids[snap.endpoint_id] = node_id
                positions.append(snap.position_m)
                nodes.append(node_id)
        positions.append(edge.geometry.length)
        nodes.append(edge.target)
        for index, (start, end) in enumerate(zip(positions, positions[1:], strict=False)):
            if end - start <= 1e-6:
                continue
            segment = substring(edge.geometry, start, end)
            result.append(RoadEdge(
                f"{edge.edge_id}@{index}", nodes[index], nodes[index + 1], segment, segment.length,
                edge.highway, edge.access, edge.bridge, edge.tunnel, edge.edge_id,
            ))
    return result, node_ids
