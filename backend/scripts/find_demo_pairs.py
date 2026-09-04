"""Deterministically identify credible GridPath demo endpoint pairs.

Runs only against persisted prepared data and the production candidate/metric
functions. It does not alter scenario data or API behaviour.
"""

from __future__ import annotations

import json
from collections import Counter
from itertools import combinations
from pathlib import Path

import networkx as nx
from shapely.geometry import Point, shape
from shapely.ops import unary_union

from app.planning import _export
from app.road_graph import load_road_edges, metric, undirected_graph
from app.route_candidates import candidate_pool, is_continuous_candidate
from app.route_metrics import line_from_edges, metrics, shared_edge_percentage
from app.scenario_repository import ScenarioRepository

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "cache" / "demo-pair-search.json"


def signature(item: dict) -> tuple[str, ...]:
    return tuple(edge.original_edge_id or edge.edge_id for edge in item["candidate"].edges)


def evaluate_pair(
    start: str, end: str, edges: list, environmental, water, buildings
) -> tuple[list[dict], Counter[str]]:
    """Use production candidate generation and metric functions, then validate."""
    result: list[dict] = []
    rejected: Counter[str] = Counter()
    for candidate in candidate_pool(edges, start, end, environmental, water):
        if not is_continuous_candidate(candidate.edges):
            rejected["disconnected_edge_chain"] += 1
            continue
        line = line_from_edges(candidate.edges)
        corridor = line.buffer(2)
        if line.is_empty or not line.is_valid or not corridor.is_valid:
            rejected["invalid_or_empty_geometry"] += 1
            continue
        if corridor.intersects(buildings):
            rejected["building_conflict"] += 1
            continue
        values = metrics(candidate.edges, line, corridor, environmental, water)
        if values["length_m"] > 1500:
            rejected["route_length"] += 1
            continue
        result.append({"candidate": candidate, "line": line, "values": values})
    if not result:
        return [], rejected
    shortest = min(result, key=lambda x: (x["values"]["length_m"], x["candidate"].rank))
    detour_limit = shortest["values"]["length_m"] * 1.35 + 0.1
    retained = [x for x in result if x["values"]["length_m"] <= detour_limit]
    rejected["detour"] += len(result) - len(retained)
    return retained, rejected


def winners(items: list[dict]) -> list[dict]:
    shortest = min(items, key=lambda x: (x["values"]["length_m"], x["candidate"].rank))
    low_impact = min(
        items,
        key=lambda x: (
            x["values"]["environmental_overlap_m2"],
            x["values"]["water_crossings"],
            x["values"]["major_road_exposure_m"],
            x["values"]["length_m"],
            x["candidate"].rank,
        ),
    )
    constructability = min(
        items,
        key=lambda x: (
            x["values"]["road_tunnel_exposure_m"],
            x["values"]["road_bridge_exposure_m"],
            x["values"]["water_crossings"],
            x["values"]["major_road_exposure_m"],
            x["values"]["turn_count"],
            x["values"]["length_m"],
            x["candidate"].rank,
        ),
    )
    return [shortest, low_impact, constructability]


def tradeoff_sentence(selected: list[dict]) -> str:
    """State measured differences without treating route distinctness as an objective."""
    shortest, low_impact, constructability = selected
    if signature(shortest) == signature(low_impact) == signature(constructability):
        return "One corridor independently wins all three measured objectives."
    short_values = shortest["values"]
    impact_values = low_impact["values"]
    construct_values = constructability["values"]
    environmental_change = (
        short_values["environmental_overlap_m2"] - impact_values["environmental_overlap_m2"]
    )
    return (
        "Low impact changes environmental overlap by "
        f"{environmental_change:.1f} m² "
        f"for {impact_values['length_m'] - short_values['length_m']:.1f} m extra length; "
        "constructability changes turns by "
        f"{short_values['turn_count'] - construct_values['turn_count']} for "
        f"{construct_values['length_m'] - short_values['length_m']:.1f} m extra length."
    )


def main() -> None:
    scenario = ScenarioRepository().load()
    features = scenario.layers["features"]
    edges = load_road_edges(features)
    graph = undirected_graph(edges)
    by_node: dict[str, Point] = {}
    for edge in edges:
        by_node.setdefault(edge.source, Point(edge.geometry.coords[0]))
        by_node.setdefault(edge.target, Point(edge.geometry.coords[-1]))
    study = unary_union(
        [metric(shape(f["geometry"])) for f in features if f["properties"]["layer"] == "study_area"]
    )
    buildings = unary_union(
        [metric(shape(f["geometry"])) for f in features if f["properties"]["layer"] == "buildings"]
    )
    protected = unary_union(
        [
            metric(shape(f["geometry"]))
            for f in features
            if f["properties"]["layer"] == "statutory_protected"
        ]
    )
    environmental = unary_union(
        [
            metric(shape(f["geometry"]))
            for f in features
            if f["properties"]["layer"] == "environmental_sensitivity"
        ]
    )
    water = unary_union(
        [metric(shape(f["geometry"])) for f in features if f["properties"]["layer"] == "water"]
    )
    hard_exclusions = unary_union([buildings, protected])
    nodes = [
        (key, point)
        for key, point in sorted(by_node.items())
        if study.covers(point) and not hard_exclusions.covers(point)
    ]
    # Spatially distributed deterministic sample; avoids an expensive all-pairs sweep.
    sampled = nodes[:: max(1, len(nodes) // 28)][:28]
    totals = Counter(
        {
            "disconnected_edge_chain": 0,
            "repeated_canonical_edge": 0,
            "loop_or_backtracking": 0,
            "invalid_or_empty_geometry": 0,
            "building_conflict": 0,
            "route_length": 0,
            "detour": 0,
            "connector_length": 0,
        }
    )
    ranked: list[dict] = []
    for (start, start_point), (end, end_point) in combinations(sampled, 2):
        direct = start_point.distance(end_point)
        if not 400 <= direct <= 950:
            totals["direct_distance"] += 1
            continue
        totals["geometrically_considered"] += 1
        if not nx.has_path(graph, start, end):
            totals["disconnected"] += 1
            continue
        network_length = nx.shortest_path_length(graph, start, end, weight="weight")
        if network_length > 1500:
            totals["network_length"] += 1
            continue
        totals["routed"] += 1
        candidates, rejected = evaluate_pair(start, end, edges, environmental, water, buildings)
        totals.update(rejected)
        if not candidates:
            totals["invalid_candidates"] += 1
            continue
        selected = winners(candidates)
        objective_names = ("shortest", "low_impact", "constructability")
        winner_labels = {
            signature(item): label for label, item in zip(objective_names, selected, strict=True)
        }
        grouped: dict[tuple[str, ...], dict] = {}
        for item in selected:
            grouped.setdefault(signature(item), item)
        unique = list(grouped.values())
        totals[f"unique_{len(unique)}"] += 1
        overlaps = [
            {
                "objectives": [
                    winner_labels[signature(left)],
                    winner_labels[signature(right)],
                ],
                "shared_edge_overlap_pct": shared_edge_percentage(
                    left["candidate"].edges, right["candidate"].edges
                ),
            }
            for left, right in combinations(unique, 2)
        ]
        overlap = max((item["shared_edge_overlap_pct"] for item in overlaps), default=100.0)
        summary = []
        for label, item in zip(objective_names, selected, strict=True):
            values = item["values"]
            summary.append(
                {
                    "objective": label,
                    "length_m": values["length_m"],
                    "environmental_overlap_m2": values["environmental_overlap_m2"],
                    "water_crossings": values["water_crossings"],
                    "bridge_m": values["road_bridge_exposure_m"],
                    "tunnel_m": values["road_tunnel_exposure_m"],
                    "major_road_m": values["major_road_exposure_m"],
                    "turns": values["turn_count"],
                    "edge_ids": list(signature(item)),
                }
            )
            summary[-1]["water_exposure_m"] = round(item["line"].intersection(water).length, 1)
            summary[-1]["connector_lengths_m"] = [0.0, 0.0]
        tradeoff = tradeoff_sentence(selected)
        score = (
            len(unique) * 10000
            + (100 - overlap) * 20
            + max(0, 1500 - min(x["values"]["length_m"] for x in unique))
        )
        ranked.append(
            {
                "grid_connection": _export(start_point)["coordinates"],
                "proposed_development": _export(end_point)["coordinates"],
                "direct_distance_m": round(direct, 1),
                "valid_candidates": len(candidates),
                "unique_objective_winners": len(unique),
                "max_shared_edge_overlap_pct": overlap,
                "winners": summary,
                "tradeoff": tradeoff,
                "score": round(score, 2),
            }
        )
        ranked[-1]["pairwise_shared_edge_overlap"] = overlaps
    ranked.sort(
        key=lambda item: (-item["score"], item["grid_connection"], item["proposed_development"])
    )
    output = {"totals": dict(totals), "top_five": ranked[:5]}
    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
