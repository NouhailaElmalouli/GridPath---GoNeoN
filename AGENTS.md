# Codex Project Instructions

## Mission

Build a deployed, visual MVP for the goNEON Platform & Ecosystem Owner exercise.

GridPath is an underground infrastructure corridor-screening planning prototype
for one prepared peri-urban Zurich-region scenario. A user explicitly selects
Point A and Point B, and the system screens mapped road-corridor alternatives
against spatial constraints and engineering assumptions.

GridPath is an adjacent platform-extension concept created for this exercise,
not an official goNEON product. It complements goNEON Corridor Studies rather
than recreating it: Corridor Studies performs cycling-network routing over
existing streets, while GridPath evaluates deterministic graph-based
underground-corridor alternatives on a prepared road network.

## Fixed MVP scope

- One prepared 1–2 km² peri-urban Zurich-region study area.
- One infrastructure type: underground infrastructure corridor screening.
- User-selected Point A and Point B within the prepared study area.
- Up to three alternatives: shortest, low environmental impact, and
  constructability.
- React + TypeScript + MapLibre frontend, contextual 3D visualization, and
  FastAPI backend.
- Shapely/GeoPandas spatial validation in EPSG:2056 and NetworkX routing over a
  prepared road graph.
- Engineering-screening measures including building clearance, corridor width,
  environmental overlap, water crossings, and road exposure.
- Deterministic candidate generation, metric evaluation, and alternative
  comparison.

## Explicit non-goals

- No user accounts, database, collaboration, persistence, uploads, or city-wide support.
- No multiple infrastructure types, production load testing, or live Overpass/WFS demo dependency.
- No regulatory approval, construction-ready design, utility-capacity analysis,
  land-rights determination, or ownership verification.
- Do not add features unless they fix a broken core flow.

## Spatial rules

- Keep web-map data and API exchange geometries in EPSG:4326.
- Reproject to EPSG:2056 before any buffer, distance, area, routing, or validation.
- Persist prepared normalized GeoJSON under `data/processed/`.
- Revalidate every returned route and its corridor buffer against original
  vector constraints after graph routing completes.
- Distinguish screening constraints from deterministic comparison metrics, label
  data sources, and include the planning-prototype disclaimer.

## Engineering rules

- Prefer the smallest reliable implementation that proves the end-to-end flow.
- Keep routing, validation, and scoring in separate modules.
- Use typed request/response models and deterministic tests before changing routing or scoring.
- Never commit secrets or API keys.
- Update README instructions whenever setup or commands change.

## Product language

Do not claim regulatory compliance or construction readiness. Say "constraint
validation" and "planning prototype." The core explanation is:

> The planner selects endpoints; deterministic spatial functions generate,
> measure, validate, and compare mapped underground-corridor alternatives.
