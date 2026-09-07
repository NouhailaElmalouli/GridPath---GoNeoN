# GridPath MVP Product Scope

GridPath is a focused underground-infrastructure corridor-screening prototype
for the goNEON Platform & Ecosystem Owner exercise. It demonstrates the kind of
deterministic planning workflow that could be built on top of a broader
infrastructure-planning platform; it is not an official goNEON product.

## Problem demonstrated

Early corridor discussions often need a fast, transparent way to compare
plausible connections before detailed survey, rights, utility, and approval
work begins. GridPath lets a planner choose two nearby locations and screens
mapped road-corridor alternatives against a prepared set of engineering and
environmental considerations. The value of the MVP is an explainable comparison
of alternatives, not an automated route approval.

## Intended user

The intended user is an engineering or planning professional exploring an
underground-infrastructure connection within the prepared Zurich-region study
area. They use the prototype to set Point A and Point B, review the resulting
corridor options, and understand their measured trade-offs.

## Current functionality

- A planner explicitly selects Point A and Point B within the prepared study
  area, subject to the MVP's 1 km maximum straight-line separation.
- The service validates and snaps those locations to the eligible prepared road
  network.
- Deterministic graph-based routing generates candidate underground-corridor
  paths from the prepared network.
- A requested corridor width and building-clearance assumptions are evaluated
  in a metric Swiss coordinate system, alongside mapped environmental and
  access-related indicators.
- The prototype compares up to three objective-led alternatives: shortest, low
  environmental impact, and constructability.
- Returned WGS84 GeoJSON and route metrics are visualized in 2D MapLibre and a
  contextual 3D view when configured; an assessment can be exported as GeoJSON.

## Deliberately out of scope

- City-wide, multi-scenario, or live-data operation.
- Routing outside the prepared road network or selecting a real utility
  alignment.
- Detailed utility capacity, subsurface conditions, survey, land ownership,
  easements, cost estimation, permitting, or stakeholder workflow.
- Regulatory compliance, safety certification, construction design, or a
  recommendation to build.
- User accounts, persistence, collaboration, uploads, and production-scale
  operational controls.

## Prototype limitations

The scenario relies on prepared map data, which can be incomplete or outdated.
Mapped roads are used as preliminary accessible corridor proxies, not verified
utility easements. Environmental layers are screening evidence rather than
statutory determinations, and calculated metrics are deterministic indicators
rather than field-validated facts. The 3D view is contextual visualization only.

## Why the scope is narrow

The exercise intentionally concentrates on one prepared Zurich-region scenario
and a short, user-defined connection. This keeps the end-to-end workflow
reviewable: explicit input, metric coordinate handling, deterministic candidate
generation, transparent comparison, and visual communication of results. It
shows a credible platform extension without implying that the MVP replaces
detailed engineering or approval processes.
