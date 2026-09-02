# GridPath Build Plan

## Before coding

- Open the GridPath workspace in VS Code.
- Create and activate `.venv` using the README commands.
- Install backend and frontend dependencies.
- Copy `.env.example` to `.env`.
- Confirm `pytest`, `ruff check .`, and `npm run build` pass.

## Phase 1 — Scenario contract and data (morning)

1. Inspect a few 1–2 km² Zürich AOIs for useful building, water, and green-area
   coverage.
2. Lock one AOI, a representative grid connection, and a synthetic proposed-development endpoint.
3. Implement `scripts/fetch_zurich_data.py`.
4. Normalize the source data into explicit GeoJSON layers.
5. Define typed scenario models and `GET /api/scenario`.

**Exit condition:** the frontend displays the prepared constraints and endpoints
without a live Overpass request.

## Phase 2 — One valid route (afternoon)

1. Reproject scenario layers to EPSG:2056.
2. Build hard-exclusion buffers with Shapely.
3. Rasterize the AOI into a controlled-resolution grid.
4. Implement deterministic A*.
5. Convert the cell path to a LineString, apply the configurable right-of-way buffer,
   and validate both again as vector data.
6. Add unit tests for an open path, blocked path, and clearance violation.

**Exit condition:** `POST /api/plan` returns one valid route with length,
clearance, and violation metrics.

## Phase 3 — Map integration (evening)

1. Draw exclusions and buffers.
2. Draw the generated route.
3. Display a minimal metrics card.
4. Confirm repeated identical requests return identical outputs.

Do not begin alternative generation, the LLM, or visual polish until one route
works end to end.

## First Codex prompt

> Read AGENTS.md, README.md, docs/product-scope.md, docs/architecture.md, and
> docs/tomorrow-plan.md completely. Inspect the existing scaffold and tests.
> Then implement Phase 1 only: select and justify a compact Zürich AOI after
> inspecting OSM feature coverage, implement the offline data-preparation
> pipeline, define typed scenario contracts, add GET /api/scenario, add tests,
> and render the prepared scenario layers in MapLibre. Keep all metric geometry
> operations in EPSG:2056 and all browser exchange geometry in EPSG:4326. Do
> not implement routing or agent behavior yet. Validate backend lint/tests and
> frontend lint/build when done.
