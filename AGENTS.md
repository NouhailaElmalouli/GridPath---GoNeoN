# Codex Project Instructions

## Mission

Build a deployed, visual MVP for the goNEON Platform & Ecosystem Owner exercise.
The submission deadline is Friday, 4 September 2026 at 20:00 CEST. The internal
code-freeze target is Friday at 12:00 CEST.

The product is an agentic utility-corridor alignment planner for one prepared
scenario in Zürich. It connects a fixed origin and destination while avoiding
buildings, water, and protected/green areas and respecting configurable safety
clearances.

## Fixed MVP scope

- One prepared 1–2 km² Zürich scenario.
- One infrastructure type: underground utility/power corridor.
- Three alternatives: shortest feasible, maximum clearance, and balanced.
- React + TypeScript + MapLibre frontend.
- FastAPI backend.
- Shapely/GeoPandas spatial validation in EPSG:2056.
- A* pathfinding over a deterministic cost grid.
- AI parses user intent into typed parameters, calls deterministic tools, and
  explains results. AI never calculates compliance, geometry, or scores.
- Hosted link, usage instructions, and a three-part recorded walkthrough.

## Explicit non-goals

- No user accounts, database, collaboration, or persistence.
- No arbitrary file uploads.
- No city-wide or multi-city support.
- No multiple infrastructure types.
- No production load testing.
- No live Overpass/WFS dependency during the demo.
- No photorealistic 3D requirement.
- Do not add features after Thursday night unless they fix a broken core flow.

## Spatial rules

- Keep web-map data in EPSG:4326.
- Reproject to EPSG:2056 before any buffer, distance, area, or route calculation.
- Persist the prepared scenario as normalized GeoJSON under `data/processed/`.
- Every returned route must be revalidated against the original vector
  constraints with Shapely after A* completes.
- Distinguish hard exclusions from soft costs.
- Label all data sources and include the planning-prototype disclaimer.

## Engineering rules

- Prefer the smallest reliable implementation that proves the end-to-end flow.
- Keep routing, validation, scoring, and agent orchestration in separate modules.
- Use typed request/response models at API boundaries.
- Add deterministic unit tests before changing routing or scoring behavior.
- Never commit secrets or API keys.
- Keep the demo operable without an OpenAI key by providing a deterministic
  example/fallback command parser.
- Update README instructions whenever setup or commands change.

## Product language

Do not claim regulatory compliance. Say "constraint validation" and
"planning prototype." The core explanation is:

> AI interprets the planner's intent and orchestrates the workflow; deterministic
> spatial functions generate, measure, and validate every result.

## Tomorrow's first task

Implement the prepared Zürich dataset pipeline and define the typed scenario
contract before styling or adding agent behavior. Then implement and test one
valid A* route before generating alternatives.

