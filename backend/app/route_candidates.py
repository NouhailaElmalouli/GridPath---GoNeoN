"""Deterministic, diverse candidates on the undirected physical street topology."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import networkx as nx

from app.road_graph import RoadEdge, undirected_graph

MAJOR_ROADS = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link"}
RESTRICTED_ACCESS = {"private", "no"}
LOCAL_ROADS = {"service", "residential", "living_street", "unclassified", "tertiary", "secondary"}


@dataclass(frozen=True)
class Candidate:
    edges: list[RoadEdge]
    rank: int
    generation_strategy: str


def is_continuous_candidate(edges: list[RoadEdge]) -> bool:
    """Reject repeated physical edges, loops, and disconnected edge chains."""
    if not edges or len({edge.original_edge_id or edge.edge_id for edge in edges}) != len(edges):
        return False
    return all(
        {left.source, left.target} & {right.source, right.target}
        and left.geometry.distance(right.geometry) <= 1e-6
        for left, right in zip(edges, edges[1:], strict=False)
    )


def _crossings(edge: RoadEdge, water: Any) -> int:
    geometries = getattr(water, "geoms", [water])
    return sum(1 for geometry in geometries if edge.geometry.intersects(geometry))


def edge_cost(edge: RoadEdge, strategy: str, environmental: Any, water: Any) -> float:
    """Use only persisted edge tags and prepared vector layers for costs."""
    length = edge.length_m
    if strategy == "shortest":
        return length
    corridor = edge.geometry.buffer(2)
    environmental_area = (
        corridor.intersection(environmental).area if not environmental.is_empty else 0
    )
    crossings = _crossings(edge, water) if not water.is_empty else 0
    if strategy == "environmental":
        return length + environmental_area * 4 + crossings * 500
    road_factor = 1.0 if edge.highway in LOCAL_ROADS else 2.0
    if edge.highway in MAJOR_ROADS:
        road_factor = 10.0
    value = length * road_factor
    if edge.access in RESTRICTED_ACCESS:
        value += length * 12
    if edge.bridge:
        value += 450
    if edge.tunnel:
        value += 450
    return value


def _paths(graph: nx.Graph, start: str, end: str) -> Iterator[list[str]]:
    try:
        yield from nx.shortest_simple_paths(graph, start, end, weight="weight")
    except nx.NetworkXNoPath as error:
        raise ValueError("No eligible mapped road corridor connects snapped endpoints.") from error


def candidate_pool(
    edges: list[RoadEdge], start: str, end: str, environmental: Any, water: Any, limit: int = 24
) -> list[Candidate]:
    """Generate deterministic k-shortest candidates and shared-edge-penalty variants."""
    result: list[Candidate] = []
    seen: set[tuple[str, ...]] = set()
    for strategy in ("shortest", "environmental", "constructability"):
        costs = {edge.edge_id: edge_cost(edge, strategy, environmental, water) for edge in edges}
        graph = undirected_graph(edges, costs)
        generated = 0
        for path in _paths(graph, start, end):
            path_edges = [graph.edges[a, b]["edge"] for a, b in zip(path, path[1:], strict=False)]
            key = tuple(edge.edge_id for edge in path_edges)
            if key in seen or not is_continuous_candidate(path_edges):
                continue
            seen.add(key)
            result.append(Candidate(path_edges, len(result) + 1, strategy))
            generated += 1
            if generated >= 8 or len(result) >= limit:
                break
        if len(result) >= limit:
            break
    used: set[str] = set()
    for strategy in ("shortest", "environmental", "constructability"):
        if len(result) >= limit:
            break
        costs = {edge.edge_id: edge_cost(edge, strategy, environmental, water) for edge in edges}
        for _ in range(8):
            penalized_costs = {
                key: value * (4 if key in used else 1) for key, value in costs.items()
            }
            graph = undirected_graph(edges, penalized_costs)
            try:
                path = next(_paths(graph, start, end))
            except ValueError:
                break
            path_edges = [graph.edges[a, b]["edge"] for a, b in zip(path, path[1:], strict=False)]
            key = tuple(edge.edge_id for edge in path_edges)
            used.update(key)
            if key not in seen and is_continuous_candidate(path_edges):
                seen.add(key)
                result.append(Candidate(path_edges, len(result) + 1, f"{strategy}_diversified"))
                if len(result) >= limit:
                    break
    return result


def route_candidate(
    edges: list[RoadEdge], start: str, end: str, strategy: str, avoided: set[str]
) -> Candidate:
    """Compatibility helper retained for the single-plan endpoint."""
    graph = undirected_graph(
        edges,
        {edge.edge_id: edge.length_m * (10 if edge.edge_id in avoided else 1) for edge in edges},
    )
    path = next(_paths(graph, start, end))
    path_edges = [graph.edges[a, b]["edge"] for a, b in zip(path, path[1:], strict=False)]
    return Candidate(path_edges, 1, strategy)
