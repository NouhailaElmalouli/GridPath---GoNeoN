from enum import StrEnum

from pydantic import BaseModel, Field


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
