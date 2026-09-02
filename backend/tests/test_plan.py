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


def test_alternatives_reports_all_profiles_and_convergence() -> None:
    response = TestClient(app).post(
        "/api/plan/alternatives", json={"scenario_id": "zurich-dietikon-urdorf-v1"}
    )
    assert response.status_code == 200
    alternatives = response.json()["alternatives"]
    assert [alternative["strategy"] for alternative in alternatives] == [
        "shortest",
        "environmental",
        "balanced",
    ]
    assert all(alternative["feasible"] for alternative in alternatives)
    assert response.json()["distinctness"]["shortest:balanced"]["hausdorff_distance_m"] == 0
