from fastapi import APIRouter, Depends, HTTPException

from app.planning import PlanningError, alternatives, plan
from app.scenario_repository import ScenarioRepository
from app.schemas import AlternativesResponse, PlanRequest, PlanResponse

from .scenario import get_scenario_repository

router = APIRouter(tags=["planning"])


@router.post("/plan", response_model=PlanResponse)
def create_plan(
    request: PlanRequest,
    repository: ScenarioRepository = Depends(get_scenario_repository),  # noqa: B008
) -> PlanResponse:
    scenario = repository.load()
    try:
        return plan(scenario.metadata.scenario_id, scenario.layers["features"], request)
    except PlanningError as error:
        raise HTTPException(
            status_code=422,
            detail={
                "code": error.code,
                "message": error.message,
                "measurements": error.assumptions,
                "suggestions": ["Reduce building clearance or right-of-way width if appropriate."],
            },
        ) from error


@router.post("/plan/alternatives", response_model=AlternativesResponse)
def create_alternatives(
    request: PlanRequest,
    repository: ScenarioRepository = Depends(get_scenario_repository),  # noqa: B008
) -> AlternativesResponse:
    scenario = repository.load()
    try:
        return alternatives(scenario.metadata.scenario_id, scenario.layers["features"], request)
    except PlanningError as error:
        raise HTTPException(
            status_code=422,
            detail={
                "code": error.code,
                "message": error.message,
                "measurements": error.assumptions,
            },
        ) from error
