# GridPath
<img width="222" height="52" alt="image" src="https://github.com/user-attachments/assets/aab139f5-0e98-49ab-87be-aa82395c7d38" />

GridPath is an end-to-end infrastructure corridor screening MVP built for the goNEON Platform & Ecosystem Owner exercise.

It demonstrates how a user can select two planning locations and rapidly screen underground corridor alternatives against engineering and environmental constraints.

## Live MVP

Hosted GridPath application: https://gridpath-six.vercel.app/

For usage instructions, see [INSTRUCTIONS.md](./INSTRUCTIONS.md).

## What it demonstrates

- User-defined Point A and Point B
- Maximum 1 km screening distance
- Building-clearance and corridor-width assumptions
- Deterministic candidate corridor generation
- Comparison of route objectives including shortest, environmental impact and constructability
- Prepared geospatial context for the Dietikon–Urdorf area
- 2D analytical view and 3D contextual visualization
- Technical route metrics and assessment export

## Architecture

Frontend:
- React
- TypeScript
- Vite
- MapLibre
- Google Maps 3D visualization

Backend:
- FastAPI
- Python
- GeoPandas / Shapely
- NetworkX
- OSMnx

Deployment:
- Frontend: Vercel
- API: Railway

## Scope

This is intentionally a narrow overnight MVP.

It is not intended to produce a regulatory-approved or construction-ready alignment. Its purpose is to demonstrate an extensible planning workflow that could sit on top of a broader infrastructure-planning platform.

## Running locally

See the existing development setup below.
