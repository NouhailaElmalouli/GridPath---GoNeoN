import math
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, field_validator


class OptimizationStrategy(StrEnum):
    SHORTEST = "shortest"
    LOWEST_ENVIRONMENTAL_IMPACT = "lowest_environmental_impact"
    BALANCED = "balanced"


class PlanningStrategy(StrEnum):
    SHORTEST = "shortest"
    ENVIRONMENTAL = "environmental"
    CONSTRUCTABILITY = "constructability"
    BALANCED = "balanced"


class PlanningConstraints(BaseModel):
    building_clearance_m: float = Field(default=25, ge=0, le=100)
    right_of_way_buffer_m: float = Field(default=30, ge=0, le=100)
    avoid_protected_areas: bool = True
    strategy: OptimizationStrategy = OptimizationStrategy.BALANCED


class HealthResponse(BaseModel):
    status: str
    service: str


class ScenarioBounds(BaseModel):
    west: float
    south: float
    east: float
    north: float


class ScenarioEndpoint(BaseModel):
    id: str
    label: str
    coordinates: tuple[float, float]
    provenance: str


class ScenarioMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scenario_id: str
    scenario_name: str
    selected_location: str
    bounds: ScenarioBounds
    source: str
    retrieved_at: str
    source_crs: str
    analysis_crs: str
    layer_counts: dict[str, int]
    statutory_protected_present: bool
    limitations: list[str]
    disclaimer: str
    endpoints: list[ScenarioEndpoint]


class ScenarioResponse(BaseModel):
    metadata: ScenarioMetadata
    layers: dict[str, object]


class Wgs84Point(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: str
    coordinates: tuple[float, float]

    @field_validator("type")
    @classmethod
    def require_point(cls, value: str) -> str:
        if value != "Point":
            raise ValueError("GeoJSON endpoint type must be Point")
        return value

    @field_validator("coordinates")
    @classmethod
    def require_wgs84(cls, value: tuple[float, float]) -> tuple[float, float]:
        longitude, latitude = value
        if not all(math.isfinite(coordinate) for coordinate in value):
            raise ValueError("Endpoint coordinates must be finite")
        if not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
            raise ValueError("Endpoint coordinates must be WGS84 longitude/latitude")
        return value


class PlanRequest(BaseModel):
    scenario_id: str
    building_clearance_m: float = Field(default=25, ge=0, le=100)
    right_of_way_width_m: float = Field(default=4, ge=2, le=80)
    corridor_width_m: float = Field(default=4, ge=2, le=12)
    strategy: PlanningStrategy = PlanningStrategy.BALANCED
    grid_connection: Wgs84Point | None = None
    proposed_development: Wgs84Point | None = None


class ValidationCheck(BaseModel):
    id: str
    label: str
    passed: bool
    measured_value: float
    required_value: float
    unit: str
    explanation: str


class PlanResponse(BaseModel):
    plan_id: str
    strategy: str
    grid_resolution_m: float
    computation_duration_ms: float
    feasible: bool
    centreline: dict[str, object]
    corridor: dict[str, object]
    right_of_way: dict[str, object]
    hard_exclusion_envelope: dict[str, object]
    endpoint_connectors: dict[str, object]
    endpoint_markers: dict[str, object]
    raw_vertex_count: int
    simplified_vertex_count: int
    route_length_m: float
    direct_distance_m: float
    detour_ratio: float
    buildings_intersecting_right_of_way: int
    minimum_building_clearance_m: float = 0
    environmental_sensitivity_overlap_m2: float
    water_crossing_count: int
    bridge_tunnel_exposure_m: float
    major_road_exposure_m: float
    turn_count: int
    street_network_percentage: float
    edge_ids: list[str]
    validation_checks: list[ValidationCheck]
    warnings: list[str]
    calculation_trace: list[str]
    strategy_cost: float = 0
    converged_with: list[str] = []
    display_name: str = ""
    connector_lengths_m: dict[str, float] = {}
    road_class_breakdown: dict[str, float] = {}
    bridge_count: int = 0
    tunnel_count: int = 0
    constructability_score: float = 0
    candidate_rank: int = 1
    pairwise_overlap: dict[str, float] = {}
    selected_endpoints: dict[str, dict[str, object]] = {}
    snapped_road_points: dict[str, dict[str, object]] = {}
    straight_line_endpoint_distance_m: float = 0
    snapped_osm_edge_ids: dict[str, str] = {}
    endpoint_mode: str = "demo"
    strategy_note: str = ""


class AlternativesResponse(BaseModel):
    assumptions: PlanRequest
    alternatives: list[PlanResponse]
    distinctness: dict[str, dict[str, float]]
    default_selection: str = "balanced"
    comparison_runtime_ms: float
    candidate_count: int = 0
    topology_limitation: str | None = None
