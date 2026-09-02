# MVP Product Scope

## User story

As an infrastructure planner, I want to describe corridor priorities in plain
language and compare feasible alignments so that I can understand spatial
trade-offs before detailed engineering begins.

## Prepared scenario

- Location: a compact study area in Zürich, selected after data inspection.
- Origin: representative substation/utility connection point.
- Destination: representative development connection point.
- Hard exclusions: building safety buffers, protected areas, and water.
- Soft costs: route length, proximity to buildings, and proximity to sensitive
  green areas.

The endpoints describe a demonstrative planning scenario and must not be
presented as an actual proposed infrastructure project.

## Primary interaction

1. The user enters or selects a planning objective.
2. The agent converts it into typed constraints and priorities.
3. The deterministic engine creates three alternatives.
4. Every alternative is validated against vector constraints.
5. The interface compares length, clearance, violations, and score.
6. The agent explains why the routes differ and recommends a route only in the
   context of the stated priorities.

## Acceptance criteria

- A first-time reviewer can run the core workflow without instructions.
- The map visibly distinguishes endpoints, exclusions, buffers, and routes.
- Changing clearance or priority produces a deterministic recalculation.
- Invalid routes are rejected or visibly marked, never silently accepted.
- The same request and scenario produce the same computed routes and metrics.
- The app remains demonstrable if the LLM request fails.

