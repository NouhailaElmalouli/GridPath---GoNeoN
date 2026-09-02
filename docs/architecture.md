# Technical Architecture

```text
React + MapLibre
      |
      | typed JSON
      v
FastAPI orchestration
      |
      +--> intent parser / optional LLM
      |
      +--> scenario repository (prepared GeoJSON)
      |
      +--> raster cost surface + A*
      |
      +--> Shapely vector validation
      |
      +--> deterministic scoring
```

## Coordinate reference systems

- Browser and persisted exchange geometries: WGS84 / EPSG:4326.
- All metric spatial analysis: CH1903+ / LV95 / EPSG:2056.

Never call `buffer`, calculate distance, or create the A* grid in geographic
degrees.

## Proposed backend modules

- `scenario_repository.py`: load and validate prepared layers.
- `cost_surface.py`: rasterize hard exclusions and soft penalties.
- `routing.py`: run A* and alternative strategies.
- `validation.py`: calculate vector intersections and minimum clearances.
- `scoring.py`: rank alternatives from explicit weights.
- `agent.py`: parse intent, orchestrate tools, and explain results.

## API target

- `GET /api/health`
- `GET /api/scenario`
- `POST /api/plan`
- `POST /api/interpret`

Only the health endpoint is included in the initial scaffold.

