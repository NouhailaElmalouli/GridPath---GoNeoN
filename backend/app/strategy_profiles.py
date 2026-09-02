"""Centralized dimensionless soft-cost weights for deterministic strategies."""

from dataclasses import dataclass


@dataclass(frozen=True)
class StrategyProfile:
    environmental: float
    water: float
    building_proximity: float


PROFILES = {
    "shortest": StrategyProfile(environmental=0.0, water=0.4, building_proximity=0.1),
    "environmental": StrategyProfile(environmental=12.0, water=30.0, building_proximity=1.5),
    "balanced": StrategyProfile(environmental=2.0, water=7.0, building_proximity=1.5),
}
