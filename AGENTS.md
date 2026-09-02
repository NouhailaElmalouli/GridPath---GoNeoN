# Codex Project Instructions

## Mission

Build a deployed, visual MVP for the goNEON Platform & Ecosystem Owner exercise.
The submission deadline is Friday, 4 September 2026 at 20:00 CEST. The internal
code-freeze target is Friday at 12:00 CEST.

The product is GridPath: an agentic power-line alignment and right-of-way
screening planning prototype for one prepared peri-urban Zurich-region scenario.
It connects a representative grid connection point and an explicitly synthetic
proposed development while screening spatial constraints and safety buffers.

GridPath is an adjacent platform-extension concept created for this exercise,
not an official goNEON product. It complements goNEON Corridor Studies rather
than recreating it: Corridor Studies performs cycling-network routing over
existing streets, while GridPath evaluates free-space territorial alignment over
a raster cost surface for overhead power-transmission infrastructure.

## Fixed MVP scope

- One prepared 1-2 km2 peri-urban Zurich-region study area.
- One infrastructure type: overhead power-transmission alignment.
- One representative grid connection and one synthetic proposed-development endpoint.
- Three alternatives: shortest feasible, lowest environmental impact, and balanced.
- React + TypeScript + MapLibre frontend and FastAPI backend.
- Shapely/GeoPandas spatial validation in EPSG:2056 and A* over a deterministic cost grid.
- Hard exclusions: building footprints plus configurable safety buffers and protected areas.
- Soft penalties: forest/green areas, water crossings, settlement proximity, and length.
- AI interprets intent and orchestrates tools; deterministic code generates,
  measures, validates, and scores every route.

## Explicit non-goals

- No user accounts, database, collaboration, persistence, uploads, or city-wide support.
- No multiple infrastructure types, production load testing, or live Overpass/WFS demo dependency.
- No photorealistic 3D requirement.
- Do not add features after Thursday night unless they fix a broken core flow.

## Spatial rules

- Keep web-map data in EPSG:4326.
- Reproject to EPSG:2056 before any buffer, distance, area, routing, or validation.
- Persist prepared normalized GeoJSON under `data/processed/`.
- Revalidate every returned route and its right-of-way buffer against original
  vector constraints after A* completes.
- Distinguish hard exclusions from soft costs, label data sources, and include
  the planning-prototype disclaimer.

## Engineering rules

- Prefer the smallest reliable implementation that proves the end-to-end flow.
- Keep routing, validation, scoring, and agent orchestration in separate modules.
- Use typed request/response models and deterministic tests before changing routing or scoring.
- Never commit secrets or API keys.
- Keep the demo operable without an OpenAI key using a deterministic fallback parser.
- Update README instructions whenever setup or commands change.

## Product language

Do not claim regulatory compliance or construction readiness. Say "constraint
validation" and "planning prototype." The core explanation is:

> AI interprets the planner's intent and orchestrates the workflow; deterministic
> spatial functions generate, measure, and validate every result.

## Tomorrow's first task

Implement the prepared Zurich-region dataset pipeline and typed scenario
contract before adding agent behavior. Then implement and test one valid A*
alignment before generating alternatives.
