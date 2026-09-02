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
