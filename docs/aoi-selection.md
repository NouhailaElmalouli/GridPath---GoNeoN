# Zurich-region AOI selection

Retrieval date: 2026-09-02. Candidate checks used one cached, sequential OSMnx
multi-tag query within 600 m of each supplied centre (approximately 1.13 km2).
Counts below are approximate tag-presence counts from the union query; each
feature was subsequently classified by its actual tags.

| Candidate | Buildings | Power | Green / forest tags | Water / waterway tags | Assessment |
| --- | ---: | ---: | ---: | ---: | --- |
| Dietikon/Urdorf, 47.397, 8.414 | 430 | 0 | 40 | 22 | Mixed peri-urban fabric, visible open land, and clear water/green context. |
| Schlieren/Altstetten, 47.400, 8.456 | 553 | 2 | 42 | 10 | Useful power mapping but more urbanised and visually denser. |
| Regensdorf, 47.432, 8.468 | 960 | 1 | 20 | 33 | Strong water coverage but considerably denser settlement fabric. |

## Selected area

GridPath uses a 1.44 km2 square centred near Dietikon/Urdorf. It is the clearest
of the candidates for a compact peri-urban feasibility demonstration: it has a
substantial building context while preserving open land and a legible mix of
green and water features. It avoids airport-related complexity and does not
present an overwhelmingly dense urban core.

No `power=substation` was returned in the selected AOI, so the grid connection
is explicitly synthetic and labelled as such. The proposed-development endpoint
is also synthetic and represents no actual project.

During the Phase 2 endpoint validation, the original synthetic proposed-
development point was found to overlap a mapped water feature. It was moved
approximately 30 m to a nearby open, routable synthetic point through the
offline preparation script, then the canonical scenario and manifest were
regenerated. No mapped OSM feature was changed.

## Data limitations

No `boundary=protected_area` or `leisure=nature_reserve` feature was mapped in
the selected OSM result. This does not establish the absence of legal protection.
Forest, park, wetland, and water layers are environmental-sensitivity proxies,
not statutory protected-area data. OpenStreetMap is volunteered mapping and is
not an official environmental, land-rights, or engineering register.
