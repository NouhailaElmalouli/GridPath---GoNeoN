from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class OptimizationStrategy(StrEnum):
    SHORTEST = "shortest"
    LOWEST_ENVIRONMENTAL_IMPACT = "lowest_environmental_impact"
    BALANCED = "balanced"


class PlanningStrategy(StrEnum):
    SHORTEST = "shortest"
    ENVIRONMENTAL = "environmental"
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


class PlanRequest(BaseModel):
    scenario_id: str
    building_clearance_m: float = Field(default=25, ge=10, le=60)
    right_of_way_width_m: float = Field(default=40, ge=20, le=80)
    strategy: PlanningStrategy = PlanningStrategy.BALANCED


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
    right_of_way: dict[str, object]
    hard_exclusion_envelope: dict[str, object]
    raw_vertex_count: int
    simplified_vertex_count: int
    route_length_m: float
    direct_distance_m: float
    detour_ratio: float
    minimum_building_clearance_m: float
    buildings_intersecting_right_of_way: int
    statutory_protected_overlap_m2: float
    environmental_sensitivity_overlap_m2: float
    water_crossing_count: int
    water_overlap_length_m: float
    validation_checks: list[ValidationCheck]
    warnings: list[str]
    calculation_trace: list[str]
    strategy_cost: float = 0
    converged_with: list[str] = []


class AlternativesResponse(BaseModel):
    assumptions: PlanRequest
    alternatives: list[PlanResponse]
    distinctness: dict[str, dict[str, float]]
    default_selection: str = "balanced"
    comparison_runtime_ms: float
