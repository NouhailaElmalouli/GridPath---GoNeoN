from enum import StrEnum

from pydantic import BaseModel, Field


class OptimizationStrategy(StrEnum):
    SHORTEST = "shortest"
    MAX_CLEARANCE = "max_clearance"
    BALANCED = "balanced"


class PlanningConstraints(BaseModel):
    building_clearance_m: float = Field(default=25, ge=0, le=100)
    avoid_protected_areas: bool = True
    avoid_water: bool = True
    strategy: OptimizationStrategy = OptimizationStrategy.BALANCED


class HealthResponse(BaseModel):
    status: str
    service: str

