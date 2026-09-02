"""Deterministic 5 m balanced-alignment planner for the prepared scenario."""

from __future__ import annotations

import heapq
import math
import time
from dataclasses import dataclass
from hashlib import sha256
from typing import Any

import numpy as np
from pyproj import Transformer
from shapely import contains, distance, intersects, points
from shapely.geometry import LineString, Point, mapping, shape
from shapely.ops import unary_union

from app.schemas import AlternativesResponse, PlanRequest, PlanResponse, ValidationCheck
from app.strategy_profiles import PROFILES, StrategyProfile

GRID_RESOLUTION_M = 5.0
# Dimensionless multipliers applied to metre movement cost. Kept here for auditability.
ENVIRONMENTAL_TRAVERSAL_WEIGHT = 2.0
WATER_TRAVERSAL_WEIGHT = 7.0
BUILDING_PROXIMITY_WEIGHT = 1.5
BUILDING_PROXIMITY_DECAY_M = 35.0
WGS84_TO_METRIC = Transformer.from_crs("EPSG:4326", "EPSG:2056", always_xy=True)
METRIC_TO_WGS84 = Transformer.from_crs("EPSG:2056", "EPSG:4326", always_xy=True)


class PlanningError(Exception):
    def __init__(self, code: str, message: str, assumptions: dict[str, float]) -> None:
        self.code, self.message, self.assumptions = code, message, assumptions
        super().__init__(message)


@dataclass
class PreparedScenario:
    study_area: Any
    buildings: Any
    protected: Any
    environmental: Any
    water: Any
    endpoints: dict[str, Point]


def _project(geometry: Any) -> Any:
    from shapely.ops import transform

    return transform(WGS84_TO_METRIC.transform, geometry)


def _export(geometry: Any) -> dict[str, Any]:
    from shapely.ops import transform

    return mapping(transform(METRIC_TO_WGS84.transform, geometry))


def prepare_scenario(features: list[dict[str, Any]]) -> PreparedScenario:
    layers: dict[str, list[Any]] = {}
    endpoints: dict[str, Point] = {}
    for feature in features:
        properties = feature["properties"]
        geometry = shape(feature["geometry"])
        if properties["layer"] == "endpoints":
            endpoints[properties["endpoint_id"]] = _project(geometry)
        else:
            layers.setdefault(properties["layer"], []).append(_project(geometry))

    def merged(layer: str) -> Any:
        return unary_union(layers.get(layer, []))

    return PreparedScenario(
        study_area=merged("study_area"),
        buildings=merged("buildings"),
        protected=merged("statutory_protected"),
        environmental=merged("environmental_sensitivity"),
        water=merged("water"),
        endpoints=endpoints,
    )


def validate_endpoints(scenario: PreparedScenario) -> None:
    for endpoint_id, endpoint in scenario.endpoints.items():
        invalid = (
            not scenario.study_area.covers(endpoint)
            or scenario.buildings.covers(endpoint)
            or scenario.water.covers(endpoint)
            or scenario.environmental.covers(endpoint)
        )
        if invalid:
            raise PlanningError(
                "invalid_endpoint",
                f"Prepared endpoint '{endpoint_id}' is outside the routable scenario context.",
                {},
            )


def hard_exclusion(scenario: PreparedScenario, request: PlanRequest) -> Any:
    building_distance = request.building_clearance_m + request.right_of_way_width_m / 2
    parts = [scenario.buildings.buffer(building_distance)]
    if not scenario.protected.is_empty:
        parts.append(scenario.protected.buffer(request.right_of_way_width_m / 2))
    return unary_union(parts)


@dataclass
class CostGrid:
    xmin: float
    ymin: float
    width: int
    height: int
    blocked: np.ndarray
    costs: np.ndarray

    def point_for(self, node: tuple[int, int]) -> Point:
        col, row = node
        return Point(
            self.xmin + (col + 0.5) * GRID_RESOLUTION_M, self.ymin + (row + 0.5) * GRID_RESOLUTION_M
        )

    def node_for(self, point: Point) -> tuple[int, int]:
        col = min(max(int((point.x - self.xmin) // GRID_RESOLUTION_M), 0), self.width - 1)
        row = min(max(int((point.y - self.ymin) // GRID_RESOLUTION_M), 0), self.height - 1)
        return col, row


def build_cost_grid(
    scenario: PreparedScenario, exclusions: Any, profile: StrategyProfile
) -> CostGrid:
    xmin, ymin, xmax, ymax = scenario.study_area.bounds
    width = math.ceil((xmax - xmin) / GRID_RESOLUTION_M)
    height = math.ceil((ymax - ymin) / GRID_RESOLUTION_M)
    cols, rows = np.meshgrid(np.arange(width), np.arange(height))
    xs = xmin + (cols.ravel() + 0.5) * GRID_RESOLUTION_M
    ys = ymin + (rows.ravel() + 0.5) * GRID_RESOLUTION_M
    cell_points = points(xs, ys)
    inside = contains(scenario.study_area, cell_points)
    blocked = np.logical_or(~inside, intersects(exclusions, cell_points)).reshape(height, width)
    costs = np.zeros_like(xs, dtype=float)
    if not scenario.environmental.is_empty:
        costs += contains(scenario.environmental, cell_points) * profile.environmental
    if not scenario.water.is_empty:
        costs += contains(scenario.water, cell_points) * profile.water
    if not scenario.buildings.is_empty:
        building_distance = distance(cell_points, scenario.buildings)
        costs += profile.building_proximity * np.exp(
            -building_distance / BUILDING_PROXIMITY_DECAY_M
        )
    return CostGrid(xmin, ymin, width, height, blocked, costs.reshape(height, width))


NEIGHBOURS = ((0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1))


def astar(grid: CostGrid, start: Point, end: Point) -> list[tuple[int, int]]:
    source, target = grid.node_for(start), grid.node_for(end)
    if grid.blocked[source[1], source[0]] or grid.blocked[target[1], target[0]]:
        raise PlanningError(
            "endpoint_blocked", "An endpoint lies in the hard-exclusion envelope.", {}
        )
    queue: list[tuple[float, float, int, int]] = []
    heapq.heappush(queue, (0.0, 0.0, source[1], source[0]))
    predecessor: dict[tuple[int, int], tuple[int, int]] = {}
    best = {source: 0.0}
    while queue:
        _, _, row, col = heapq.heappop(queue)
        node = (col, row)
        if node == target:
            path = [node]
            while path[-1] in predecessor:
                path.append(predecessor[path[-1]])
            return list(reversed(path))
        current_cost = best[node]
        for dc, dr in NEIGHBOURS:
            candidate = (col + dc, row + dr)
            nc, nr = candidate
            if nc < 0 or nr < 0 or nc >= grid.width or nr >= grid.height or grid.blocked[nr, nc]:
                continue
            if dc and dr and (grid.blocked[row, nc] or grid.blocked[nr, col]):
                continue
            movement = GRID_RESOLUTION_M * (math.sqrt(2) if dc and dr else 1.0)
            cost = current_cost + movement * (1 + (grid.costs[row, col] + grid.costs[nr, nc]) / 2)
            if cost >= best.get(candidate, math.inf):
                continue
            best[candidate] = cost
            predecessor[candidate] = node
            heuristic = math.hypot(target[0] - nc, target[1] - nr) * GRID_RESOLUTION_M
            heapq.heappush(queue, (cost + heuristic, heuristic, nr, nc))
    raise PlanningError(
        "no_path", "No feasible balanced alignment exists for these assumptions.", {}
    )


def simplify_line(points_: list[Point], exclusions: Any, study_area: Any) -> LineString:
    accepted = [points_[0]]
    cursor = 0
    while cursor < len(points_) - 1:
        chosen = cursor + 1
        for candidate in range(len(points_) - 1, cursor, -1):
            segment = LineString([points_[cursor], points_[candidate]])
            if study_area.covers(segment) and not exclusions.intersects(segment):
                chosen = candidate
                break
        accepted.append(points_[chosen])
        cursor = chosen
    return LineString(accepted)


def _water_crossings(line: LineString, water: Any) -> int:
    return sum(1 for geometry in getattr(water, "geoms", [water]) if line.intersects(geometry))


def validation_checks(
    scenario: PreparedScenario, line: LineString, row: Any, request: PlanRequest
) -> list[ValidationCheck]:
    clearance = row.distance(scenario.buildings) if not scenario.buildings.is_empty else math.inf
    overlap = row.intersection(scenario.buildings).area if not scenario.buildings.is_empty else 0.0
    protected_overlap = (
        row.intersection(scenario.protected).area if not scenario.protected.is_empty else 0.0
    )
    return [
        ValidationCheck(
            id="inside_study_area",
            label="Alignment inside study area",
            passed=scenario.study_area.covers(row),
            measured_value=1,
            required_value=1,
            unit="boolean",
            explanation="The complete right-of-way is inside the prepared study area.",
        ),
        ValidationCheck(
            id="building_clearance",
            label="Building clearance from right-of-way",
            passed=clearance + 1e-6 >= request.building_clearance_m,
            measured_value=round(clearance, 2),
            required_value=request.building_clearance_m,
            unit="m",
            explanation=(
                "Distance is measured from the right-of-way outer edge to building footprints."
            ),
        ),
        ValidationCheck(
            id="building_intersection",
            label="Buildings intersecting right-of-way",
            passed=overlap == 0,
            measured_value=round(overlap, 2),
            required_value=0,
            unit="m²",
            explanation="No building footprint may intersect the right-of-way.",
        ),
        ValidationCheck(
            id="protected_intersection",
            label="Protected-area overlap",
            passed=protected_overlap == 0,
            measured_value=round(protected_overlap, 2),
            required_value=0,
            unit="m²",
            explanation="Statutory protected areas are hard exclusions.",
        ),
        ValidationCheck(
            id="valid_geometry",
            label="Valid vector geometries",
            passed=line.is_valid and row.is_valid,
            measured_value=1 if line.is_valid and row.is_valid else 0,
            required_value=1,
            unit="boolean",
            explanation="Centreline and right-of-way must be valid geometries.",
        ),
    ]


def plan(scenario_id: str, features: list[dict[str, Any]], request: PlanRequest) -> PlanResponse:
    if request.scenario_id != scenario_id:
        raise PlanningError(
            "unknown_scenario",
            "The requested scenario ID does not match the prepared scenario.",
            {},
        )
    started = time.perf_counter()
    scenario = prepare_scenario(features)
    validate_endpoints(scenario)
    exclusions = hard_exclusion(scenario, request)
    profile = PROFILES[str(request.strategy)]
    grid = build_cost_grid(scenario, exclusions, profile)
    start, end = scenario.endpoints["grid_connection"], scenario.endpoints["proposed_development"]
    nodes = astar(grid, start, end)
    raw_points = [start, *[grid.point_for(node) for node in nodes], end]
    raw_line = LineString(raw_points)
    simplified = simplify_line(raw_points, exclusions, scenario.study_area)
    row = simplified.buffer(request.right_of_way_width_m / 2)
    checks = validation_checks(scenario, simplified, row, request)
    if not all(check.passed for check in checks):
        simplified, row = raw_line, raw_line.buffer(request.right_of_way_width_m / 2)
        checks = validation_checks(scenario, simplified, row, request)
    if not all(check.passed for check in checks):
        raise PlanningError(
            "vector_validation_failed", "The route grid result failed final vector validation.", {}
        )
    direct = start.distance(end)
    environmental_area = (
        row.intersection(scenario.environmental).area
        if not scenario.environmental.is_empty
        else 0.0
    )
    water_length = (
        simplified.intersection(scenario.water).length if not scenario.water.is_empty else 0.0
    )
    plan_key = (
        f"{scenario_id}|{request.building_clearance_m}|{request.right_of_way_width_m}|balanced"
    )
    return PlanResponse(
        plan_id=sha256(plan_key.encode()).hexdigest()[:16],
        strategy=str(request.strategy),
        grid_resolution_m=GRID_RESOLUTION_M,
        computation_duration_ms=round((time.perf_counter() - started) * 1000, 1),
        feasible=True,
        centreline=_export(simplified),
        right_of_way=_export(row),
        hard_exclusion_envelope=_export(exclusions),
        raw_vertex_count=len(raw_points),
        simplified_vertex_count=len(simplified.coords),
        route_length_m=round(simplified.length, 1),
        direct_distance_m=round(direct, 1),
        detour_ratio=round(simplified.length / direct, 3),
        minimum_building_clearance_m=round(row.distance(scenario.buildings), 1),
        buildings_intersecting_right_of_way=0,
        statutory_protected_overlap_m2=0.0,
        environmental_sensitivity_overlap_m2=round(environmental_area, 1),
        water_crossing_count=_water_crossings(simplified, scenario.water),
        water_overlap_length_m=round(water_length, 1),
        validation_checks=checks,
        warnings=["Environmental and water features are soft costs in this planning prototype."],
        calculation_trace=[
            "Project scenario to EPSG:2056",
            "Build hard-exclusion envelope",
            "Create 5 m cost grid",
            "Run balanced A*",
            "Simplify alignment",
            "Generate right-of-way",
            "Validate vector result",
            "Calculate metrics",
        ],
        strategy_cost=round(
            simplified.length * (1 + profile.environmental * environmental_area / max(row.area, 1)),
            1,
        ),
    )


def alternatives(
    scenario_id: str, features: list[dict[str, Any]], request: PlanRequest
) -> AlternativesResponse:
    started = time.perf_counter()
    plans = [
        plan(scenario_id, features, request.model_copy(update={"strategy": strategy}))
        for strategy in ("shortest", "environmental", "balanced")
    ]
    distinctness: dict[str, dict[str, float]] = {}
    for index, left in enumerate(plans):
        left_line = shape(left.centreline)
        for right in plans[index + 1 :]:
            right_line = shape(right.centreline)
            hausdorff = left_line.hausdorff_distance(right_line)
            distinctness[f"{left.strategy}:{right.strategy}"] = {
                "hausdorff_distance_m": round(hausdorff, 1),
                "length_difference_m": round(abs(left.route_length_m - right.route_length_m), 1),
                "environmental_overlap_difference_m2": round(
                    abs(
                        left.environmental_sensitivity_overlap_m2
                        - right.environmental_sensitivity_overlap_m2
                    ),
                    1,
                ),
            }
            if hausdorff < 10 and abs(left.route_length_m - right.route_length_m) < 10:
                left.converged_with.append(right.strategy)
                right.converged_with.append(left.strategy)
    return AlternativesResponse(
        assumptions=request,
        alternatives=plans,
        distinctness=distinctness,
        comparison_runtime_ms=round((time.perf_counter() - started) * 1000, 1),
    )
