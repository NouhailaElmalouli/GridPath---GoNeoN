# GridPath

**Agentic power-line alignment and right-of-way screening**

GridPath is an early-stage feasibility planning prototype for overhead power-transmission alignments in one prepared peri-urban Zurich-region study area. It compares candidate alignments between a representative grid connection point and an explicitly synthetic proposed development.

AI interprets the planner's intent and orchestrates the workflow; deterministic spatial functions generate, measure, validate, and score every result.

GridPath is an adjacent platform-extension concept created for this exercise, not an official goNEON product. It differs from goNEON Corridor Studies, which uses existing street networks to evaluate cycling-route variants and road-design consequences. GridPath instead evaluates free-space territorial alignment and right-of-way, environmental, and settlement constraints for power transmission.

## Repository structure

```text
backend/             FastAPI API and deterministic spatial services
frontend/            React, TypeScript, Vite, and MapLibre interface
data/raw/            Download cache (not committed)
data/processed/      Committed canonical prepared demo scenario
docs/                Product scope and architecture decisions
scripts/             Data preparation and local development helpers
```

## Prerequisites

- Python 3.12
- Node.js 20+
- Git

## Windows setup

```powershell
python -m venv .venv
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
cd backend
python -m pip install -e ".[dev]"
cd ..\frontend
npm install
cd ..
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

## Run locally

```powershell
# Backend
.\.venv\Scripts\Activate.ps1
cd backend
uvicorn app.main:app --reload --port 8000
```

In a second PowerShell window:

```powershell
cd frontend
npm run dev
```

Open <http://localhost:5173>. The API health endpoint is <http://localhost:8000/api/health>.

## Balanced alignment calculation

`POST /api/plan` uses the committed scenario only. It runs deterministic A* on a
5 m EPSG:2056 grid with eight-direction movement and Euclidean heuristic. The
building hard-exclusion distance is `building_clearance_m + right_of_way_width_m / 2`;
clearance is measured from the outer right-of-way edge. Statutory protected
areas are hard exclusions; environmental and water layers are soft penalties.

```json
{"scenario_id":"zurich-dietikon-urdorf-v1","building_clearance_m":25,"right_of_way_width_m":40,"strategy":"balanced"}
```

The response contains EPSG:4326 centreline, right-of-way, exclusion-envelope,
metrics, vector-validation checks, and a deterministic calculation trace.
The 5 m grid is appropriate for early screening only; it is not transmission
engineering, a land-rights assessment, or regulatory approval.

## Checks

```powershell
cd backend
pytest
ruff check .

cd ..\frontend
npm run lint
npm run build
```

## Data policy

The demo uses a small committed OpenStreetMap-derived Zurich-region dataset
prepared during development. Runtime requests never depend on Overpass or
municipal WFS availability. See `docs/aoi-selection.md` for source limitations.

Planning prototype only. Results are not regulatory-compliance determinations, construction-ready alignments, or a substitute for statutory, environmental, land-rights, or engineering review.
