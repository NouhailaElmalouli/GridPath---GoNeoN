"""Metric geometry and transparent route-comparison measures."""

from __future__ import annotations

import math
from typing import Any

from shapely.geometry import LineString

from app.road_graph import RoadEdge
from app.route_candidates import MAJOR_ROADS


def line_from_edges(edges: list[RoadEdge]) -> LineString:
    coordinates: list[tuple[float, float]] = []
    for edge in edges:
        part = list(edge.geometry.coords)
        reverse_distance = LineString([coordinates[-1], part[-1]]).length if coordinates else 0
        forward_distance = LineString([coordinates[-1], part[0]]).length if coordinates else 0
        if coordinates and reverse_distance < forward_distance:
            part.reverse()
        coordinates.extend(part if not coordinates else part[1:])
    return LineString(coordinates)


def turn_count(line: LineString) -> int:
    turns = 0
    for before, current, after in zip(line.coords, line.coords[1:], line.coords[2:], strict=False):
        first = math.atan2(current[1] - before[1], current[0] - before[0])
        second = math.atan2(after[1] - current[1], after[0] - current[0])
        if abs((second - first + math.pi) % (2 * math.pi) - math.pi) > math.radians(25):
            turns += 1
    return turns


def shared_edge_percentage(left: list[RoadEdge], right: list[RoadEdge]) -> float:
    denominator = max(1, min(len(left), len(right)))
    shared = len({edge.edge_id for edge in left} & {edge.edge_id for edge in right})
    return round(100 * shared / denominator, 1)


def metrics(
    edges: list[RoadEdge], line: LineString, corridor: Any, environmental: Any, water: Any
) -> dict[str, float | int]:
    environmental_overlap = (
        corridor.intersection(environmental).area if not environmental.is_empty else 0
    )
    water_crossings = sum(
        1 for geometry in getattr(water, "geoms", [water]) if line.intersects(geometry)
    )
    bridge_tunnel = sum(edge.length_m for edge in edges if edge.bridge or edge.tunnel)
    major = sum(edge.length_m for edge in edges if edge.highway in MAJOR_ROADS)
    return {
        "length_m": round(line.length, 1),
        "environmental_overlap_m2": round(environmental_overlap, 1),
        "water_crossings": water_crossings,
        "bridge_tunnel_exposure_m": round(bridge_tunnel, 1),
        "major_road_exposure_m": round(major, 1),
        "turn_count": turn_count(line),
    }
