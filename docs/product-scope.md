# GridPath MVP Product Scope

GridPath is an agentic power-line alignment and right-of-way screening concept
for this exercise, not an official goNEON product. It is adjacent to goNEON
Corridor Studies: Corridor Studies routes cycling infrastructure over existing
streets; GridPath evaluates free-space overhead power-transmission alignment
over a raster cost surface.

## User story

As an infrastructure planner, I want to describe power-line alignment priorities
in plain language and compare feasible alternatives so that I can understand
right-of-way, environmental, and settlement trade-offs before detailed engineering begins.

## Prepared scenario

- Location: a compact study area in Zürich, selected after data inspection.
- Origin: representative grid connection point.
- Destination: explicitly synthetic proposed development endpoint.
- Infrastructure: overhead power-transmission alignment with a configurable
  right-of-way buffer.
- Hard exclusions: building footprints plus configurable safety buffers and
  explicitly protected areas.
- Soft penalties: forest/green areas, water crossings, proximity to settlements,
  and route length.

The endpoints describe a demonstrative planning scenario and must not be
presented as an actual proposed infrastructure project.

## Primary interaction

1. The user enters or selects a planning objective.
2. The agent converts it into typed constraints and priorities.
3. The deterministic engine creates shortest-feasible, lowest-environmental-impact,
   and balanced alternatives.
4. Every alternative is validated against vector constraints.
5. The interface compares length, minimum settlement clearance, buildings within
   right-of-way, protected-area intersection, forest overlap, water crossings,
   and deterministic composite score.
6. The agent explains why the routes differ and recommends a route only in the
   context of the stated priorities.

## Acceptance criteria

- A first-time reviewer can run the core workflow without instructions.
- The map visibly distinguishes endpoints, exclusions, buffers, and routes.
- Changing the right-of-way buffer or priority produces a deterministic recalculation.
- Invalid routes are rejected or visibly marked, never silently accepted.
- The same request and scenario produce the same computed routes and metrics.
- The app remains demonstrable if the LLM request fails.
