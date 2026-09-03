import json

# ruff: noqa: E501
from fastapi.testclient import TestClient
from shapely.geometry import Point, shape

from app.main import app
from app.planning import _export
from app.road_graph import load_road_edges, metric
from app.scenario_repository import ScenarioRepository

SCENARIO_ID = "zurich-dietikon-urdorf-v1"
VALID_CUSTOM = {
    "grid_connection": {"type": "Point", "coordinates": [8.4089, 47.3947]},
    "proposed_development": {"type": "Point", "coordinates": [8.4156, 47.3919]},
}


def custom_payload(**overrides: object) -> dict[str, object]:
    return {"scenario_id": SCENARIO_ID, **VALID_CUSTOM, **overrides}


def exact_distance_points(distance_m: float) -> tuple[dict[str, object], dict[str, object]]:
    features = ScenarioRepository().load().layers["features"]
    edges = load_road_edges(features)
    for source in edges:
        start = Point(source.geometry.coords[0])
        for target in edges:
            first, last = Point(target.geometry.coords[0]), Point(target.geometry.coords[-1])
            if (start.distance(first) - distance_m) * (start.distance(last) - distance_m) > 0:
                continue
            low, high = 0.0, target.geometry.length
            for _ in range(50):
                middle = (low + high) / 2
                if (start.distance(target.geometry.interpolate(low)) - distance_m) * (start.distance(target.geometry.interpolate(middle)) - distance_m) <= 0:
                    high = middle
                else:
                    low = middle
            return _export(start), _export(target.geometry.interpolate((low + high) / 2))
    raise AssertionError("Prepared road graph has no exact-distance test pair")


def point_inside(layer: str) -> dict[str, object]:
    feature = next(feature for feature in ScenarioRepository().load().layers["features"] if feature["properties"]["layer"] == layer)
    geometry = metric(shape(feature["geometry"]))
    return _export(geometry.representative_point())


def assert_wgs84(value: object) -> None:
    if isinstance(value, dict):
        if "coordinates" in value:
            assert_coordinates(value["coordinates"])
        for child in value.values():
            assert_wgs84(child)
    elif isinstance(value, list):
        for child in value:
            assert_wgs84(child)


def assert_coordinates(value: object) -> None:
    if isinstance(value, (tuple, list)) and value and isinstance(value[0], (int, float)):
        longitude, latitude = value[:2]
        assert -180 <= longitude <= 180 and -90 <= latitude <= 90
        return
    for child in value:  # type: ignore[union-attr]
        assert_coordinates(child)


def test_single_plan_is_feasible_and_deterministic() -> None:
    client = TestClient(app)
    payload = {"scenario_id": "zurich-dietikon-urdorf-v1"}
    first = client.post("/api/plan", json=payload)
    second = client.post("/api/plan", json=payload)
    assert first.status_code == second.status_code == 200
    assert first.json()["centreline"] == second.json()["centreline"]
    assert first.json()["plan_id"] == second.json()["plan_id"]


def test_unknown_scenario_has_structured_planning_error() -> None:
    response = TestClient(app).post("/api/plan", json={"scenario_id": "unknown"})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "unknown_scenario"


def test_alternatives_are_deterministic_valid_and_use_persisted_edges() -> None:
    client = TestClient(app)
    payload = {
        "scenario_id": "zurich-dietikon-urdorf-v1",
        "building_clearance_m": 25,
        "right_of_way_width_m": 40,
        "strategy": "balanced",
    }
    first = client.post("/api/plan/alternatives", json=payload)
    second = client.post("/api/plan/alternatives", json=payload)
    assert first.status_code == second.status_code == 200
    body = first.json()
    json.dumps(body, allow_nan=False)
    alternatives = body["alternatives"]
    assert [item["strategy"] for item in alternatives] == [
        "shortest", "environmental", "constructability"
    ]
    assert len({item["strategy"] for item in alternatives}) == 3
    assert body["candidate_count"] >= 20
    persisted_ids = {
        feature["properties"]["edge_id"]
        for feature in ScenarioRepository().load().layers["features"]
        if feature["properties"].get("layer") == "road_network"
    }
    for alternative in alternatives:
        centreline = shape(alternative["centreline"])
        assert centreline.is_valid and centreline.geom_type == "LineString"
        assert all(-180 <= x <= 180 and -90 <= y <= 90 for x, y in centreline.coords)
        assert alternative["endpoint_connectors"]["type"] == "FeatureCollection"
        assert len(alternative["endpoint_connectors"]["features"]) == 2
        assert all(
            feature["properties"]["kind"] == "synthetic_connector"
            for feature in alternative["endpoint_connectors"]["features"]
        )
        assert set(alternative["edge_ids"]).issubset(persisted_ids)
        assert alternative["validation_checks"]
    assert first.json() == second.json()


def test_alternative_overlap_is_based_on_actual_selected_edges() -> None:
    body = TestClient(app).post(
        "/api/plan/alternatives", json={"scenario_id": "zurich-dietikon-urdorf-v1"}
    ).json()
    alternatives = {item["strategy"]: item for item in body["alternatives"]}
    for key, comparison in body["distinctness"].items():
        left, right = key.split(":")
        shared = set(alternatives[left]["edge_ids"]) & set(alternatives[right]["edge_ids"])
        denominator = min(len(alternatives[left]["edge_ids"]), len(alternatives[right]["edge_ids"]))
        assert comparison["shared_length_percentage"] == round(100 * len(shared) / denominator, 1)


def test_health_and_scenario_remain_available() -> None:
    client = TestClient(app)
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/scenario").status_code == 200


def test_omitted_endpoints_keep_demo_mode_and_return_endpoint_details() -> None:
    response = TestClient(app).post("/api/plan/alternatives", json={"scenario_id": SCENARIO_ID})
    assert response.status_code == 200
    alternative = response.json()["alternatives"][0]
    assert alternative["endpoint_mode"] == "demo"
    assert set(alternative["selected_endpoints"]) == {"grid_connection", "proposed_development"}
    assert set(alternative["snapped_road_points"]) == {"grid_connection", "proposed_development"}


def test_valid_custom_endpoints_are_edge_snapped_and_deterministic() -> None:
    client = TestClient(app)
    first = client.post("/api/plan/alternatives", json=custom_payload())
    second = client.post("/api/plan/alternatives", json=custom_payload())
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    alternative = first.json()["alternatives"][0]
    assert alternative["endpoint_mode"] == "user_selected"
    assert alternative["connector_lengths_m"]["grid_connection"] > 0
    assert alternative["snapped_road_points"]["grid_connection"] != alternative["selected_endpoints"]["grid_connection"]
    assert all(edge_id for edge_id in alternative["snapped_osm_edge_ids"].values())
    assert_wgs84(alternative)


def test_exactly_one_kilometre_is_accepted_and_greater_distance_is_rejected() -> None:
    first, second = exact_distance_points(1000.0)
    accepted = TestClient(app).post("/api/plan", json=custom_payload(grid_connection=first, proposed_development=second))
    assert accepted.status_code == 200
    assert accepted.json()["straight_line_endpoint_distance_m"] == 1000.0
    exceeded = TestClient(app).post("/api/plan", json=custom_payload(grid_connection={"type": "Point", "coordinates": [8.4089, 47.3947]}, proposed_development={"type": "Point", "coordinates": [8.422, 47.402]}))
    assert exceeded.status_code == 422
    detail = exceeded.json()["detail"]
    assert detail["code"] == "ENDPOINT_DISTANCE_EXCEEDED"
    assert detail["message"] == "Selected points are more than 1 km apart. Choose a closer endpoint."
    assert detail["measurements"]["threshold_m"] == 1000.0


def test_outside_exclusion_and_remote_street_points_are_rejected() -> None:
    client = TestClient(app)
    outside = client.post("/api/plan", json=custom_payload(grid_connection={"type": "Point", "coordinates": [8.404, 47.394]}))
    assert outside.status_code == 422
    assert outside.json()["detail"]["code"] == "ENDPOINT_OUTSIDE_STUDY_AREA"
    building = client.post("/api/plan", json=custom_payload(grid_connection=point_inside("buildings")))
    assert building.status_code == 422
    assert building.json()["detail"]["code"] == "ENDPOINT_IN_BUILDING"
    water = client.post("/api/plan", json=custom_payload(grid_connection=point_inside("water")))
    assert water.status_code == 422
    assert water.json()["detail"]["code"] == "ENDPOINT_IN_WATER"
    remote = client.post("/api/plan", json=custom_payload(grid_connection={"type": "Point", "coordinates": [8.406361357679904, 47.39638499700815]}))
    assert remote.status_code == 422
    assert remote.json()["detail"]["code"] == "NO_NEARBY_ROUTABLE_STREET"


def test_custom_endpoints_change_routes_without_mutating_persisted_graph() -> None:
    repository = ScenarioRepository()
    features = repository.load().layers["features"]
    before = [(feature["properties"].get("edge_id"), feature["geometry"]) for feature in features if feature["properties"].get("layer") == "road_network"]
    client = TestClient(app)
    demo = client.post("/api/plan/alternatives", json={"scenario_id": SCENARIO_ID})
    custom = client.post("/api/plan/alternatives", json=custom_payload())
    assert demo.status_code == custom.status_code == 200
    assert demo.json()["alternatives"][0]["centreline"] != custom.json()["alternatives"][0]["centreline"]
    after = [(feature["properties"].get("edge_id"), feature["geometry"]) for feature in repository.load().layers["features"] if feature["properties"].get("layer") == "road_network"]
    assert after == before


def test_strategy_winners_match_measured_objectives_for_demo_and_custom_pairs() -> None:
    payloads = [
        {"scenario_id": SCENARIO_ID},
        custom_payload(),
        custom_payload(
            grid_connection={"type": "Point", "coordinates": [8.409, 47.3946]},
            proposed_development={"type": "Point", "coordinates": [8.4154, 47.392]},
        ),
    ]
    for payload in payloads:
        response = TestClient(app).post("/api/plan/alternatives", json=payload)
        assert response.status_code == 200
        alternatives = {item["strategy"]: item for item in response.json()["alternatives"]}
        shortest = alternatives["shortest"]
        environment = alternatives["environmental"]
        constructability = alternatives["constructability"]
        assert shortest["route_length_m"] == min(
            item["route_length_m"] for item in alternatives.values()
        )
        assert (environment["environmental_sensitivity_overlap_m2"], environment["water_crossing_count"]) <= (
            shortest["environmental_sensitivity_overlap_m2"], shortest["water_crossing_count"]
        )
        assert constructability["route_length_m"] <= shortest["route_length_m"] * 1.25 + 0.1
        assert constructability["tunnel_count"] <= shortest["tunnel_count"]
        assert constructability["bridge_count"] <= shortest["bridge_count"]
        assert constructability["turn_count"] <= shortest["turn_count"]
        assert constructability["environmental_sensitivity_overlap_m2"] <= shortest["environmental_sensitivity_overlap_m2"]
        assert constructability["strategy_note"]
