from fastapi import APIRouter, Depends, HTTPException

from app.scenario_repository import ScenarioRepository, ScenarioRepositoryError
from app.schemas import ScenarioResponse

router = APIRouter(tags=["scenario"])


def get_scenario_repository() -> ScenarioRepository:
    return ScenarioRepository()


@router.get("/scenario", response_model=ScenarioResponse)
def get_scenario(
    repository: ScenarioRepository = Depends(get_scenario_repository),  # noqa: B008
) -> ScenarioResponse:
    try:
        return repository.load()
    except ScenarioRepositoryError as error:
        raise HTTPException(
            status_code=503,
            detail={"code": "scenario_unavailable", "message": str(error)},
        ) from error
