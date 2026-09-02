# Agentic Corridor Planner

A visual planning MVP that generates and validates alternative underground
utility corridors across a prepared Zürich scenario.

The system combines an agent-facing workflow with deterministic geospatial
calculation: AI interprets intent and explains trade-offs, while Shapely,
GeoPandas, and A* generate and validate the spatial result.

## Repository structure

```text
backend/             FastAPI API and deterministic spatial services
frontend/            React, TypeScript, Vite, and MapLibre interface
data/raw/            Download cache (not committed)
data/processed/      Normalized demo scenario (generated, not committed)
docs/                Product scope and architecture decisions
scripts/             Data preparation and local development helpers
```

## Prerequisites

- Python 3.11 or 3.12
- Node.js 20+
- Git

## Windows setup

Open PowerShell in the repository folder:

```powershell
py -3.12 -m venv .venv
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
cd backend
python -m pip install -e ".[dev]"
cd ..\frontend
npm install
cd ..
Copy-Item .env.example .env
```

## Run locally

Backend, from the repository root:

```powershell
.\.venv\Scripts\Activate.ps1
cd backend
uvicorn app.main:app --reload --port 8000
```

Frontend, in a second PowerShell window:

```powershell
cd frontend
npm run dev
```

Open <http://localhost:5173>. The API health endpoint is
<http://localhost:8000/api/health>.

## Connect to GitHub

The starter is prepared as a Git repository on the `main` branch. If you are
working from the downloaded archive, initialize it and connect the empty GitHub
repository you create for the exercise:

```powershell
git init -b main
git add .
git commit -m "chore: scaffold agentic corridor planner"
git remote add origin YOUR_REPOSITORY_URL
git push -u origin main
```

Do not commit `.env`, API keys, `.venv`, `node_modules`, or raw data downloads.

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

The final demo will use a small, prepared Zürich dataset downloaded during
development and committed only if licensing and file size allow it. Runtime
requests must not depend on Overpass or municipal WFS availability.

Planning prototype only. Results are not a substitute for statutory utility,
environmental, or engineering review.
