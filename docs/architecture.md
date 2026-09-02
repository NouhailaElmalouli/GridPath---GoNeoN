# GridPath Technical Architecture

GridPath is a planning-prototype extension concept, not an official goNEON
product. goNEON Corridor Studies performs cycling routing over an existing
lane-level street network; GridPath evaluates free-space territorial alignment
and right-of-way constraints for overhead power transmission. Outputs are not
regulatory-compliance determinations or construction-ready designs.

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
- `cost_surface.py`: rasterize hard exclusions and soft penalties for free-space
  power-line alignment.
- `planning.py`: construct a 5 m metric cost grid, run deterministic balanced
  A*, safely shortcut the cell path, generate the right-of-way, and validate it.
- `scoring.py`: rank alternatives from explicit weights.
- `agent.py`: parse intent, orchestrate tools, and explain results.

## API target

- `GET /api/health`
- `GET /api/scenario`
- `POST /api/plan`
- `POST /api/interpret`

The current pass includes one balanced route only. Buildings and statutory
protected areas are hard exclusions. Environmental sensitivity, water, and
building proximity outside the hard envelope are deterministic soft costs.
No alternative ranking or agent orchestration is implemented.
