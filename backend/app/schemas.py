from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class OptimizationStrategy(StrEnum):
    SHORTEST = "shortest"
    LOWEST_ENVIRONMENTAL_IMPACT = "lowest_environmental_impact"
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
