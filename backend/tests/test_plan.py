from fastapi.testclient import TestClient

from app.main import app


def test_default_plan_is_feasible_and_deterministic() -> None:
    payload = {"scenario_id": "zurich-dietikon-urdorf-v1"}
    first = TestClient(app).post("/api/plan", json=payload)
    second = TestClient(app).post("/api/plan", json=payload)
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["feasible"] is True
    assert first.json()["buildings_intersecting_right_of_way"] == 0
    assert first.json()["centreline"] == second.json()["centreline"]
    assert first.json()["plan_id"] == second.json()["plan_id"]
    assert all(check["passed"] for check in first.json()["validation_checks"])


def test_unknown_scenario_has_structured_planning_error() -> None:
    response = TestClient(app).post("/api/plan", json={"scenario_id": "unknown"})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "unknown_scenario"
