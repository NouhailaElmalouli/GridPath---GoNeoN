# GridPath Technical Architecture

GridPath is a scoped planning prototype for underground infrastructure corridor
screening, created as an extension concept for the goNEON Platform & Ecosystem
Owner exercise. It is not an official goNEON product, a regulatory-compliance
determination, or a construction-ready engineering design.

The MVP lets a planner select Point A and Point B in one prepared
Dietikon/Urdorf, Zurich-region scenario. It deterministically evaluates mapped
road-corridor alternatives between those points and returns comparable spatial
and engineering-screening measures.

```text
React + TypeScript + MapLibre (+ contextual Google Maps 3D)
      |
      | WGS84 GeoJSON request and response
      v
FastAPI
      |
      +--> prepared scenario repository (GeoJSON and manifest)
      |
      +--> endpoint validation and road-edge snapping
      |
      +--> prepared road graph + NetworkX candidate generation
      |
      +--> metric constraint validation and route metrics
      |
      +--> selected alternatives as GeoJSON
```

## Frontend and visualization

The React/TypeScript frontend loads the prepared scenario and asks the user to
place Point A and Point B on the MapLibre map. It submits both selected points
when requesting alternatives. Returned centrelines, corridor polygons,
endpoint connectors, and metrics are displayed in the 2D analytical map and
can also be shown in the contextual Google Maps photorealistic 3D view when a
Google Maps key is configured. The 3D view provides context; it does not add
engineering analysis.

## Prepared scenario repository

The FastAPI backend reads one normalized, prepared GeoJSON scenario and its
manifest from `backend/data/processed/`. The repository validates the expected
layer contract before returning scenario data. The prepared context includes
the study area, buildings, environmental-sensitivity and water layers, the
road network, and demonstrative endpoints. Routing uses this prepared data and
does not require a live network-data request.

## Coordinate reference systems

- Browser input and API exchange geometries are WGS84 / EPSG:4326 GeoJSON.
- The backend reprojects input points and scenario geometries to CH1903+ / LV95
  / EPSG:2056 before snapping, buffering, measuring, routing, or validating.
- Returned route and corridor geometries are reprojected to WGS84 for API
  responses and map display.

Metric calculations therefore use metres rather than geographic degrees.

## Endpoint selection and graph routing

The backend validates selected points against the prepared study area and
applicable mapped exclusions, enforces the MVP's endpoint-distance limit, and
snaps each point to an eligible prepared road edge. It creates a request-local
split of the relevant road edges so the selected points can participate in the
routing topology without changing the prepared dataset.

The routing topology is an undirected physical street graph built with
NetworkX. GridPath generates a deterministic pool of graph candidates using
objective-specific edge costs and shared-edge penalties to encourage useful
alternatives. It does not use free-space routing, raster cost surfaces, or the
first-prototype raster approach.

## Constraint evaluation and alternative comparison

Each candidate centreline is buffered to the requested corridor width in
EPSG:2056. Candidates that fail the mapped building or statutory-protected-area
screening checks are excluded. For each remaining candidate, deterministic
metrics include length, environmental-sensitivity overlap, water crossings,
bridge/tunnel and major-road exposure, turns, connector lengths, and building
clearance.

From the candidate pool, the backend selects and compares up to three
objective winners:

- Shortest: minimum mapped-corridor length.
- Low environmental impact: lowest measured environmental and water impact,
  with documented tie-breakers.
- Constructability: a deterministic comparison of route exposure and geometry
  measures, subject to a bounded detour from the shortest candidate.

The response also records candidate rank, shared-edge overlap, validation
checks, warnings, and calculation trace information. These are screening
measures, not approval, ownership, capacity, or constructability proof.

## API response

FastAPI exposes health, scenario, single-plan, alternative-comparison, and
area-screening endpoints under `/api`. Planning responses use typed models and
include WGS84 GeoJSON geometries plus numeric metrics, so the frontend can
render and compare the results without performing its own engineering
calculation.
