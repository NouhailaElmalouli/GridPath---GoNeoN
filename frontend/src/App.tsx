import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";
import { loadGoogleMaps3D } from "./google3d";
import { MapErrorBoundary } from "./MapErrorBoundary";

type Bounds = { west: number; south: number; east: number; north: number };
type Strategy = "shortest" | "environmental" | "constructability";
type ViewMode = "2d" | "3d";
type PlacementMode = "grid_connection" | "proposed_development" | null;
type GeoPoint = { type: "Point"; coordinates: [number, number] };
type Endpoints = Partial<
  Record<"grid_connection" | "proposed_development", GeoPoint>
>;
type Scenario = {
  metadata: {
    scenario_name: string;
    selected_location: string;
    bounds: Bounds;
    source: string;
    retrieved_at: string;
    layer_counts: Record<string, number>;
    statutory_protected_present: boolean;
    disclaimer: string;
  };
  layers: GeoJSON.FeatureCollection;
};
type PlanAlternative = {
  strategy: Strategy;
  centreline: GeoJSON.Geometry;
  right_of_way: GeoJSON.Geometry;
  endpoint_connectors: GeoJSON.FeatureCollection;
  route_length_m: number;
  buildings_intersecting_right_of_way: number;
  environmental_sensitivity_overlap_m2: number;
  water_crossing_count: number;
  water_crossings_requiring_specialist_review: number;
  bridge_count: number;
  tunnel_count: number;
  road_bridge_segments_m: number;
  road_tunnel_segments_m: number;
  turn_count: number;
  candidate_rank: number;
  pairwise_overlap: Record<string, number>;
  calculation_trace: string[];
  selected_endpoints: Record<string, GeoPoint>;
  snapped_road_points: Record<string, GeoPoint>;
  straight_line_endpoint_distance_m: number;
  connector_lengths_m: Record<string, number>;
  snapped_osm_edge_ids: Record<string, string>;
  endpoint_mode: "demo" | "user_selected";
  strategy_note: string;
  edge_ids: string[];
};
type AlternativesResponse = {
  alternatives: PlanAlternative[];
  default_selection: string;
  candidate_count: number;
};
type CorridorGroup = {
  key: string;
  alternatives: PlanAlternative[];
  representative: PlanAlternative;
};

const apiBaseUrl = "";
const googleMapsKey = (
  import.meta as ImportMeta & { env?: Record<string, string> }
).env?.VITE_GOOGLE_MAPS_API_KEY;
const googleMapsConfigured = Boolean(googleMapsKey);
const routeMeta: Record<
  Strategy,
  { label: string; color: string; note: string }
> = {
  shortest: {
    label: "Shortest",
    color: "#22e7f0",
    note: "Measured minimum-length candidate.",
  },
  environmental: {
    label: "Low impact",
    color: "#49e36e",
    note: "Measured environmental and water-impact comparison.",
  },
  constructability: {
    label: "Constructability",
    color: "#f044b7",
    note: "Measured construction-complexity comparison.",
  },
};
const layerLabels: Record<string, string> = {
  buildings: "Buildings",
  statutory_protected: "Statutory protected",
  environmental_sensitivity: "Environmental sensitivity",
  water: "Water",
  power_assets: "Power assets",
  road_network: "Prepared road network",
};
const layerStyles: Record<string, string> = {
  buildings: "buildings-fill",
  statutory_protected: "protected-fill",
  environmental_sensitivity: "environment-fill",
  water: "water-fill",
  power_assets: "power-line",
  road_network: "road-network",
};

function displayBuildingHeight(properties: GeoJSON.GeoJsonProperties): number {
  const height =
    typeof properties?.height === "number"
      ? properties.height
      : typeof properties?.height === "string" &&
          /^\s*\d+(?:\.\d+)?\s*(?:m)?\s*$/i.test(properties.height)
        ? Number.parseFloat(properties.height)
        : Number.NaN;
  if (Number.isFinite(height) && height > 0) return height;
  const rawLevels =
    properties?.["building:levels"] ?? properties?.building_levels;
  const levels =
    typeof rawLevels === "number"
      ? rawLevels
      : typeof rawLevels === "string"
        ? Number.parseFloat(rawLevels)
        : Number.NaN;
  return Number.isFinite(levels) && levels > 0 ? levels * 3 : 10;
}
function boundsFromCoordinates(
  value: unknown,
): [[number, number], [number, number]] | null {
  const positions: [number, number][] = [];
  const collect = (candidate: unknown): void => {
    if (!Array.isArray(candidate)) return;
    if (typeof candidate[0] === "number" && typeof candidate[1] === "number") {
      if (Math.abs(candidate[0]) <= 180 && Math.abs(candidate[1]) <= 90)
        positions.push([candidate[0], candidate[1]]);
      return;
    }
    candidate.forEach(collect);
  };
  collect(value);
  return positions.length
    ? [
        [
          Math.min(...positions.map((point) => point[0])),
          Math.min(...positions.map((point) => point[1])),
        ],
        [
          Math.max(...positions.map((point) => point[0])),
          Math.max(...positions.map((point) => point[1])),
        ],
      ]
    : null;
}
function distanceMeters(a?: GeoPoint, b?: GeoPoint): number | null {
  if (!a || !b) return null;
  const rad = Math.PI / 180;
  const [lon1, lat1] = a.coordinates;
  const [lon2, lat2] = b.coordinates;
  const haversine =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) *
      Math.cos(lat2 * rad) *
      Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return (
    6371008.8 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
}
function circleFeature(point: GeoPoint): GeoJSON.Feature<GeoJSON.Polygon> {
  const [longitude, latitude] = point.coordinates;
  const latitudeRadius = 1000 / 111320;
  const longitudeRadius = latitudeRadius / Math.cos((latitude * Math.PI) / 180);
  const coordinates: [number, number][] = Array.from(
    { length: 65 },
    (_, index) => {
      const angle = (index * Math.PI * 2) / 64;
      return [
        longitude + longitudeRadius * Math.cos(angle),
        latitude + latitudeRadius * Math.sin(angle),
      ];
    },
  );
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [coordinates] },
  };
}
function corridorSignature(alternative: PlanAlternative): string {
  return alternative.edge_ids.length
    ? alternative.edge_ids.join("|")
    : JSON.stringify(alternative.centreline);
}

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const googleMap = useRef<HTMLElement | null>(null);
  const googleEndpointMarkers = useRef<HTMLElement[]>([]);
  const googleLibrary = useRef<Record<
    string,
    new (options: Record<string, unknown>) => HTMLElement
  > | null>(null);
  const presentationMode = useRef<ViewMode>("2d");
  const [mapReady, setMapReady] = useState(false);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [alternatives, setAlternatives] = useState<AlternativesResponse | null>(
    null,
  );
  const [selectedStrategy, setSelectedStrategy] =
    useState<Strategy>("shortest");
  const [selectedCorridorKey, setSelectedCorridorKey] = useState<string | null>(
    null,
  );
  const [viewMode, setViewMode] = useState<ViewMode>("2d");
  const [placementMode, setPlacementMode] = useState<PlacementMode>(null);
  const [draftEndpoints, setDraftEndpoints] = useState<Endpoints>({});
  const [validatedEndpoints, setValidatedEndpoints] = useState<Endpoints>({});
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [clearance, setClearance] = useState(25);
  // Compact analytical ribbon, not a construction specification.
  const [rightOfWayWidth, setRightOfWayWidth] = useState(4);
  const [corridorDesignVisible, setCorridorDesignVisible] = useState(true);
  const [visibleLayers, setVisibleLayers] = useState<Record<string, boolean>>({
    buildings: true,
    statutory_protected: true,
    environmental_sensitivity: true,
    water: true,
    power_assets: true,
    road_network: true,
  });
  const [google3dStatus, setGoogle3dStatus] = useState<
    "missing_key" | "loading" | "ready" | "authorization_error" | "render_error"
  >(googleMapsConfigured ? "loading" : "missing_key");
  const corridorGroups = useMemo<CorridorGroup[]>(() => {
    if (!alternatives) return [];
    const grouped = new Map<string, CorridorGroup>();
    alternatives.alternatives.forEach((alternative) => {
      const key = corridorSignature(alternative);
      const current = grouped.get(key);
      if (current) current.alternatives.push(alternative);
      else grouped.set(key, { key, alternatives: [alternative], representative: alternative });
    });
    return [...grouped.values()];
  }, [alternatives]);
  const selectedCorridor =
    corridorGroups.find((group) => group.key === selectedCorridorKey) ??
    corridorGroups[0] ??
    null;
  const selectedPlan = selectedCorridor?.representative ?? null;
  const strategiesConverged = corridorGroups.length === 1;
  const demoEndpoints = useMemo<Endpoints>(() => {
    if (!scenario) return {};
    return Object.fromEntries(
      scenario.layers.features
        .filter(
          (feature) =>
            feature.properties?.layer === "endpoints" &&
            feature.geometry?.type === "Point",
        )
        .map((feature) => [
          feature.properties?.endpoint_id as string,
          {
            type: "Point",
            coordinates: (feature.geometry as GeoJSON.Point).coordinates as [
              number,
              number,
            ],
          },
        ]),
    ) as Endpoints;
  }, [scenario]);
  const userSelected = Boolean(
    draftEndpoints.grid_connection || draftEndpoints.proposed_development,
  );
  const liveDistance = distanceMeters(
    draftEndpoints.grid_connection,
    draftEndpoints.proposed_development,
  );
  const overDistance = liveDistance !== null && liveDistance > 1000;
  const readyToGenerate =
    !userSelected ||
    (Boolean(
      draftEndpoints.grid_connection && draftEndpoints.proposed_development,
    ) &&
      !overDistance);
  const displayedEndpoints =
    alternatives && selectedPlan
      ? Object.keys(validatedEndpoints).length
        ? validatedEndpoints
        : selectedPlan.selected_endpoints
      : userSelected
        ? draftEndpoints
        : demoEndpoints;
  const fitMap = useCallback(
    (
      bounds: [[number, number], [number, number]],
      maxZoom: number,
      mode = viewMode,
    ) => {
      const instance = map.current;
      if (!instance) return;
      instance.resize();
      requestAnimationFrame(() =>
        instance.fitBounds(bounds, {
          padding: { top: 86, right: 210, bottom: 86, left: 86 },
          maxZoom,
          pitch: mode === "3d" ? 55 : 0,
          bearing: mode === "3d" ? -28 : 0,
          duration: 650,
        }),
      );
    },
    [viewMode],
  );
  const focusScenario = useCallback(
    (mode = viewMode) => {
      if (!scenario) return;
      const { west, south, east, north } = scenario.metadata.bounds;
      fitMap(
        [
          [west, south],
          [east, north],
        ],
        15.3,
        mode,
      );
    },
    [scenario, fitMap, viewMode],
  );
  const focusAlternatives = useCallback(() => {
    if (!scenario || !alternatives) return;
    const routeBounds = boundsFromCoordinates(
      alternatives.alternatives.flatMap((alternative) =>
        "coordinates" in alternative.centreline
          ? [alternative.centreline.coordinates]
          : [],
      ),
    );
    const endpointBounds = boundsFromCoordinates(
      Object.values(displayedEndpoints).map((point) => point?.coordinates),
    );
    if (!routeBounds || !endpointBounds) return;
    fitMap(
      [
        [
          Math.min(routeBounds[0][0], endpointBounds[0][0]),
          Math.min(routeBounds[0][1], endpointBounds[0][1]),
        ],
        [
          Math.max(routeBounds[1][0], endpointBounds[1][0]),
          Math.max(routeBounds[1][1], endpointBounds[1][1]),
        ],
      ],
      16.1,
    );
  }, [alternatives, displayedEndpoints, fitMap, scenario]);
  const clearResults = useCallback(() => {
    setAlternatives(null);
    setValidatedEndpoints({});
    setSelectedStrategy("shortest");
    setSelectedCorridorKey(null);
  }, []);
  const startPlacement = (mode: Exclude<PlacementMode, null>) => {
    presentationMode.current = viewMode;
    if (viewMode === "2d") focusScenario("2d");
    clearResults();
    setPlanError(null);
    setPlacementMode(mode);
    if (
      mode === "proposed_development" &&
      !draftEndpoints.grid_connection &&
      demoEndpoints.grid_connection
    )
      setDraftEndpoints({ grid_connection: demoEndpoints.grid_connection });
  };
  const resetDemo = () => {
    setPlacementMode(null);
    setDraftEndpoints({});
    clearResults();
    setPlanError(null);
  };

  useEffect(() => {
    if (!scenario || !mapContainer.current || map.current) return;
    const instance = new maplibregl.Map({
      container: mapContainer.current,
      center: [8.414, 47.397],
      zoom: 14,
      style: {
        version: 8,
        sources: {
          "osm-tiles": {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          },
        },
        layers: [{ id: "osm", type: "raster", source: "osm-tiles" }],
      },
    });
    map.current = instance;
    instance.addControl(new maplibregl.NavigationControl(), "bottom-right");
    instance.on("load", () => setMapReady(true));
    return () => {
      instance.remove();
      map.current = null;
    };
  }, [scenario]);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiBaseUrl}/api/scenario`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`Scenario request failed (${response.status})`);
        return response.json() as Promise<Scenario>;
      })
      .then(setScenario)
      .catch((requestError: Error) => {
        if (requestError.name !== "AbortError") setError(requestError.message);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const stage = mapContainer.current?.parentElement;
    if (!stage || googleMap.current) return;
    let host = stage.querySelector<HTMLDivElement>(".google-3d-host");
    if (!host) {
      host = document.createElement("div");
      host.className = "google-3d-host";
      host.hidden = true;
      stage.prepend(host);
    }
    if (!googleMapsConfigured || !googleMapsKey) {
      setGoogle3dStatus("missing_key");
      return;
    }
    let cancelled = false;
    setGoogle3dStatus("loading");
    loadGoogleMaps3D(googleMapsKey)
      .then(async (google) => {
        const [maps3d, marker] = await Promise.all([
          google.maps.importLibrary("maps3d"),
          google.maps.importLibrary("marker"),
        ]);
        if (cancelled) return;
        const library = { ...maps3d, ...marker };
        googleLibrary.current = library;
        const Map3DElement = library.Map3DElement;
        const bounds = scenario?.metadata.bounds;
        const scene = new Map3DElement({
          center: {
            lat: bounds ? (bounds.south + bounds.north) / 2 : 47.397,
            lng: bounds ? (bounds.west + bounds.east) / 2 : 8.414,
            altitude: 0,
          },
          range: 1900,
          tilt: 65,
          heading: -28,
          // HYBRID is the supported photorealistic mode for the route overlays.
          mode: "HYBRID",
          defaultUIHidden: true,
        });
        googleMap.current = scene;
        host.append(scene);
        setGoogle3dStatus("ready");
      })
      .catch((loaderError: Error) => {
        if (!cancelled)
          setGoogle3dStatus(
            /ApiNotActivated|RefererNotAllowed|InvalidKey|REQUEST_DENIED/i.test(
              loaderError.message,
            )
              ? "authorization_error"
              : "render_error",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [scenario]);
  useEffect(() => {
    const host =
      mapContainer.current?.parentElement?.querySelector<HTMLDivElement>(
        ".google-3d-host",
      );
    if (!host) return;
    host.hidden = viewMode !== "3d";
    if (mapContainer.current) {
      // Keep MapLibre alive while Google is active, without allowing its
      // attribution or controls to paint above the Google scene.
      mapContainer.current.style.display = viewMode === "3d" ? "none" : "block";
      if (viewMode === "2d") map.current?.resize();
    }
    if (viewMode === "3d" && google3dStatus !== "ready")
      host.textContent =
        google3dStatus === "missing_key"
          ? "Photorealistic 3D requires a configured Google Maps key."
          : google3dStatus === "loading"
            ? "Loading Google Photorealistic 3D…"
            : google3dStatus === "authorization_error"
              ? "Google Maps authorization failed for Photorealistic 3D."
              : "Google Photorealistic 3D could not be rendered.";
  }, [google3dStatus, viewMode]);
  useEffect(() => {
    const scene = googleMap.current;
    const library = googleLibrary.current;
    if (!scene || !library || !scenario) return;
    try {
      googleEndpointMarkers.current.forEach((marker) => marker.remove());
      googleEndpointMarkers.current = [];
      scene
        .querySelectorAll("[data-gridpath-overlay], gmp-marker-3d")
        .forEach((element) => element.remove());
      document
        .querySelectorAll("gmp-marker-3d[data-gridpath-endpoint]")
        .forEach((element) => element.remove());
      const add = (element: HTMLElement) => {
        element.dataset.gridpathOverlay = "true";
        scene.append(element);
      };
      const addLine = (
        geometry: GeoJSON.Geometry,
        color: string,
        width: number,
      ) => {
        if (geometry.type !== "LineString") return;
        const Polyline3DElement = library.Polyline3DElement;
        add(
          new Polyline3DElement({
            path: geometry.coordinates.map(([lng, lat]) => ({
              lat,
              lng,
              altitude: 2,
            })),
            altitudeMode: "RELATIVE_TO_GROUND",
            drawsOccludedSegments: true,
            outerColor: "#071014",
            // Maps3D takes normalized line widths (0–1), unlike MapLibre
            // pixel widths. Supplying MapLibre values here caused the scene
            // render to reject the overlay and be replaced by an error state.
            outerWidth: 0.5,
            strokeColor: color,
            // Maps3D normalizes this field to 0–1. 0.8 is the visual
            // equivalent of the requested prominent 6–8 px selected line.
            strokeWidth: width >= 8 ? 0.8 : 0.42,
          }),
        );
      };
      const study = scenario.layers.features.find(
        (feature) => feature.properties?.layer === "study_area",
      );
      if (study?.geometry?.type === "Polygon")
        addLine(
          { type: "LineString", coordinates: study.geometry.coordinates[0] },
          "#25f4d0",
          3,
        );
      if (study?.geometry?.type === "MultiPolygon")
        study.geometry.coordinates.forEach((polygon) =>
          addLine({ type: "LineString", coordinates: polygon[0] }, "#25f4d0", 3),
        );
      const Marker3DElement = library.Marker3DElement;
      const PinElement = library.PinElement;
      if (Marker3DElement && PinElement)
        Object.entries(displayedEndpoints).forEach(([id, point]) => {
          if (!point) return;
          const isGrid = id === "grid_connection";
          const marker = new Marker3DElement({
            position: { lat: point.coordinates[1], lng: point.coordinates[0] },
            altitudeMode: "CLAMP_TO_GROUND",
            collisionBehavior: "REQUIRED",
            title: isGrid
              ? "Representative grid connection"
              : "Proposed development",
          });
          marker.dataset.gridpathEndpoint = "true";
          marker.append(
            new PinElement({
              background: isGrid ? "#25f4d0" : "#ff3ca6",
              borderColor: "#081014",
              glyphColor: "#081014",
              glyphText: isGrid ? "G" : "D",
              scale: 1.15,
            }),
          );
          googleEndpointMarkers.current.push(marker);
          add(marker);
        });
      if (!alternatives || !selectedPlan || !corridorDesignVisible) return;
      for (const group of corridorGroups)
        addLine(
          group.representative.centreline,
          routeMeta[group.representative.strategy].color,
          group.key === selectedCorridorKey ? 8 : 3,
        );
      const bounds = boundsFromCoordinates(
        selectedPlan.centreline.type === "LineString"
          ? selectedPlan.centreline.coordinates
          : [],
      );
      if (bounds) {
        const latitude = (bounds[0][1] + bounds[1][1]) / 2;
        const longitude = (bounds[0][0] + bounds[1][0]) / 2;
        const span = Math.max(
          bounds[1][0] - bounds[0][0],
          bounds[1][1] - bounds[0][1],
        );
        scene.setAttribute("center", `${latitude},${longitude},0`);
        scene.setAttribute(
          "range",
          `${Math.max(1900, Math.min(3000, span * 220000))}`,
        );
        scene.setAttribute("tilt", "55");
        scene.setAttribute("heading", "-28");
      }
      if (selectedPlan.right_of_way.type === "Polygon") {
        const Polygon3DElement = library.Polygon3DElement;
        add(
          new Polygon3DElement({
            path: selectedPlan.right_of_way.coordinates[0].map(
              ([lng, lat]) => ({
                lat,
                lng,
                altitude: 1,
              }),
            ),
            altitudeMode: "RELATIVE_TO_GROUND",
            fillColor: `${routeMeta[selectedStrategy].color}44`,
            strokeColor: routeMeta[selectedStrategy].color,
            strokeWidth: 1,
            drawsOccludedSegments: true,
          }),
        );
      }
      selectedPlan.endpoint_connectors.features.forEach((feature) => {
        if (feature.geometry)
          addLine(feature.geometry, routeMeta[selectedStrategy].color, 2);
      });
    } catch {
      // Preserve the working scene if a future optional overlay is rejected.
    }
  }, [
    alternatives,
    corridorDesignVisible,
    displayedEndpoints,
    google3dStatus,
    scenario,
    selectedPlan,
    selectedCorridorKey,
    selectedStrategy,
    corridorGroups,
  ]);
  useEffect(() => {
    const scene = googleMap.current;
    if (!scene) return;
    const place = (event: Event) => {
      if (!placementMode) return;
      event.preventDefault();
      const mapClick = event as Event & {
        position?: { lat?: number; lng?: number };
        detail?: { position?: { lat?: number; lng?: number } };
      };
      const position = mapClick.position ?? mapClick.detail?.position;
      if (
        !position ||
        typeof position.lat !== "number" ||
        typeof position.lng !== "number" ||
        !Number.isFinite(position.lat) ||
        !Number.isFinite(position.lng)
      )
        return;
      const latitude = position.lat;
      const longitude = position.lng;
      const point: GeoPoint = {
        type: "Point",
        coordinates: [longitude, latitude],
      };
      clearResults();
      setPlanError(null);
      if (placementMode === "grid_connection") {
        setDraftEndpoints({ grid_connection: point });
        setPlacementMode("proposed_development");
      } else {
        const grid = draftEndpoints.grid_connection;
        if (grid) {
          const [gridLng, gridLat] = grid.coordinates;
          const centerLongitude = (gridLng + longitude) / 2;
          const centerLatitude = (gridLat + latitude) / 2;
          scene.setAttribute("center", `${centerLatitude},${centerLongitude},0`);
          scene.setAttribute("range", "1500");
          scene.setAttribute("tilt", "55");
          scene.setAttribute("heading", "-28");
        }
        setDraftEndpoints((current) => ({
          ...current,
          proposed_development: point,
        }));
        setPlacementMode(null);
      }
    };
    scene.addEventListener("gmp-click", place);
    return () => scene.removeEventListener("gmp-click", place);
  }, [clearResults, draftEndpoints.grid_connection, placementMode]);
  useEffect(() => {
    if (!mapReady || !map.current || !scenario) return;
    const instance = map.current;
    instance.addSource("gridpath-scenario", {
      type: "geojson",
      data: scenario.layers,
    });
    const buildings: GeoJSON.Feature[] = scenario.layers.features
      .filter(
        (feature) =>
          feature.properties?.layer === "buildings" &&
          feature.geometry?.type !== "GeometryCollection",
      )
      .map((feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          display_height_m: displayBuildingHeight(feature.properties),
        },
      }));
    instance.addSource("gridpath-buildings-3d", {
      type: "geojson",
      data: { type: "FeatureCollection", features: buildings },
    });
    const layer = (
      id: string,
      type: "fill" | "line",
      filter: unknown[],
      paint: Record<string, unknown>,
    ) =>
      instance.addLayer({
        id,
        type,
        source: "gridpath-scenario",
        filter,
        paint,
      } as maplibregl.LayerSpecification);
    layer("buildings-fill", "fill", ["==", ["get", "layer"], "buildings"], {
      "fill-color": "#9aa3ae",
      "fill-opacity": 0.34,
      "fill-outline-color": "#c6ccd4",
    });
    instance.addLayer({
      id: "buildings-extrusion",
      type: "fill-extrusion",
      source: "gridpath-buildings-3d",
      paint: {
        "fill-extrusion-color": "#aeb6c0",
        "fill-extrusion-height": ["get", "display_height_m"],
        "fill-extrusion-base": 0,
        "fill-extrusion-opacity": 0.72,
        "fill-extrusion-vertical-gradient": true,
      },
    } as maplibregl.FillExtrusionLayerSpecification);
    layer(
      "protected-fill",
      "fill",
      ["==", ["get", "layer"], "statutory_protected"],
      { "fill-color": "#ec3ba6", "fill-opacity": 0.46 },
    );
    layer(
      "environment-fill",
      "fill",
      ["==", ["get", "layer"], "environmental_sensitivity"],
      { "fill-color": "#4eaa67", "fill-opacity": 0.32 },
    );
    layer("water-fill", "fill", ["==", ["get", "layer"], "water"], {
      "fill-color": "#3b9fe2",
      "fill-opacity": 0.42,
    });
    layer("water-line", "line", ["==", ["get", "layer"], "water"], {
      "line-color": "#55b7f5",
      "line-width": 2.5,
    });
    layer("power-line", "line", ["==", ["get", "layer"], "power_assets"], {
      "line-color": "#f6c453",
      "line-width": 3,
    });
    layer("road-network", "line", ["==", ["get", "layer"], "road_network"], {
      "line-color": "#758397",
      "line-width": 1.2,
      "line-opacity": 0.48,
    });
    layer(
      "scenario-study-area-halo",
      "line",
      ["==", ["get", "layer"], "study_area"],
      { "line-color": "#061015", "line-width": 7, "line-opacity": 0.78 },
    );
    layer(
      "scenario-study-area-outline",
      "line",
      ["==", ["get", "layer"], "study_area"],
      {
        "line-color": "#25f4d0",
        "line-width": 2.25,
        "line-opacity": 0.94,
        "line-dasharray": [2, 1.4],
      },
    );
  }, [mapReady, scenario]);
  useEffect(() => {
    if (!map.current || !scenario) return;
    const instance = map.current;
    const is3D = viewMode === "3d";
    if (instance.getLayer("buildings-fill"))
      instance.setLayoutProperty(
        "buildings-fill",
        "visibility",
        visibleLayers.buildings && !is3D ? "visible" : "none",
      );
    if (instance.getLayer("buildings-extrusion"))
      instance.setLayoutProperty(
        "buildings-extrusion",
        "visibility",
        visibleLayers.buildings && is3D ? "visible" : "none",
      );
    for (const [name, visible] of Object.entries(visibleLayers)) {
      if (name === "buildings") continue;
      if (instance.getLayer(layerStyles[name]))
        instance.setLayoutProperty(
          layerStyles[name],
          "visibility",
          visible ? "visible" : "none",
        );
    }
    if (instance.getLayer("environment-fill"))
      instance.setPaintProperty(
        "environment-fill",
        "fill-opacity",
        is3D ? 0.2 : 0.45,
      );
    if (instance.getLayer("water-fill"))
      instance.setPaintProperty(
        "water-fill",
        "fill-opacity",
        is3D ? 0.24 : 0.67,
      );
  }, [scenario, viewMode, visibleLayers]);
  useEffect(() => {
    if (!mapReady || !map.current) return;
    const instance = map.current;
    const handler = (event: maplibregl.MapMouseEvent) => {
      if (!placementMode || event.originalEvent.defaultPrevented) return;
      const point: GeoPoint = {
        type: "Point",
        coordinates: [event.lngLat.lng, event.lngLat.lat],
      };
      clearResults();
      setPlanError(null);
      if (placementMode === "grid_connection") {
        setDraftEndpoints({ grid_connection: point });
        setPlacementMode("proposed_development");
      } else {
        setDraftEndpoints((current) => ({
          ...current,
          proposed_development: point,
        }));
        setPlacementMode(null);
      }
    };
    instance.on("click", handler);
    return () => {
      instance.off("click", handler);
    };
  }, [clearResults, mapReady, placementMode]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPlacementMode(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => {
    if (map.current)
      map.current.getCanvas().style.cursor = placementMode ? "crosshair" : "";
  }, [placementMode]);
  useEffect(() => {
    if (!mapReady || !map.current) return;
    const instance = map.current;
    ["selection-labels", "selection-points", "selection-radius"].forEach(
      (id) => {
        if (instance.getLayer(id)) instance.removeLayer(id);
      },
    );
    ["gridpath-selection", "gridpath-radius"].forEach((id) => {
      if (instance.getSource(id)) instance.removeSource(id);
    });
    const endpoints = Object.entries(displayedEndpoints).filter(
      (entry): entry is [string, GeoPoint] => Boolean(entry[1]),
    );
    instance.addSource("gridpath-selection", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: endpoints.map(([id, point]) => ({
          type: "Feature",
          properties: {
            endpoint_id: id,
          },
          geometry: point,
        })),
      },
    });
    instance.addLayer({
      id: "selection-points",
      type: "circle",
      source: "gridpath-selection",
      paint: {
        "circle-radius": 6,
        "circle-color": [
          "match",
          ["get", "endpoint_id"],
          "grid_connection",
          "#25f4d0",
          "#f044b7",
        ],
        "circle-stroke-color": "#071014",
        "circle-stroke-width": 2.2,
      },
    });
    if (
      placementMode === "proposed_development" &&
      draftEndpoints.grid_connection
    ) {
      instance.addSource("gridpath-radius", {
        type: "geojson",
        data: circleFeature(draftEndpoints.grid_connection),
      });
      instance.addLayer({
        id: "selection-radius",
        type: "line",
        source: "gridpath-radius",
        paint: {
          "line-color": "#25f4d0",
          "line-width": 1.5,
          "line-opacity": 0.6,
          "line-dasharray": [2, 2],
        },
      } as maplibregl.LineLayerSpecification);
    }
  }, [
    displayedEndpoints,
    draftEndpoints.grid_connection,
    mapReady,
    placementMode,
  ]);
  useEffect(() => {
    if (!mapReady || !map.current || !alternatives || !selectedPlan) return;
    const instance = map.current;
    const remove = (layers: string[], source: string) => {
      layers.forEach((id) => {
        if (instance.getLayer(id)) instance.removeLayer(id);
      });
      if (instance.getSource(source)) instance.removeSource(source);
    };
    remove(["route-row-fill", "route-row-outline"], "gridpath-route-corridor");
    remove(
      ["route-connector-underlay", "route-connectors"],
      "gridpath-route-connectors",
    );
    remove(["routes-underlay", "routes-centreline"], "gridpath-routes");
    const asFeatures = (
      geometry: GeoJSON.Geometry,
    ): GeoJSON.FeatureCollection => ({
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry }],
    });
    const routes: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: corridorGroups.map((group) => ({
        type: "Feature",
        properties: {
          corridor_key: group.key,
          color: routeMeta[group.representative.strategy].color,
        },
        geometry: group.representative.centreline,
      })),
    };
    instance.addSource("gridpath-routes", { type: "geojson", data: routes });
    instance.addSource("gridpath-route-corridor", {
      type: "geojson",
      data: asFeatures(selectedPlan.right_of_way),
    });
    instance.addSource("gridpath-route-connectors", {
      type: "geojson",
      data: selectedPlan.endpoint_connectors,
    });
    const selected = [
      "==",
      ["get", "corridor_key"],
      selectedCorridorKey,
    ] as unknown as maplibregl.ExpressionSpecification;
    instance.addLayer({
      id: "route-row-fill",
      type: "fill",
      source: "gridpath-route-corridor",
      paint: {
        "fill-color": routeMeta[selectedStrategy].color,
        "fill-opacity": 0.16,
      },
    });
    instance.addLayer({
      id: "route-row-outline",
      type: "line",
      source: "gridpath-route-corridor",
      paint: {
        "line-color": routeMeta[selectedStrategy].color,
        "line-width": 1.5,
        "line-opacity": 0.82,
      },
    } as maplibregl.LineLayerSpecification);
    instance.addLayer({
      id: "route-connector-underlay",
      type: "line",
      source: "gridpath-route-connectors",
      paint: { "line-color": "#05090d", "line-width": 7, "line-opacity": 0.95 },
    } as maplibregl.LineLayerSpecification);
    instance.addLayer({
      id: "route-connectors",
      type: "line",
      source: "gridpath-route-connectors",
      paint: {
        "line-color": routeMeta[selectedStrategy].color,
        "line-width": 2.5,
        "line-opacity": 1,
        "line-dasharray": [2, 1.5],
      },
    } as maplibregl.LineLayerSpecification);
    instance.addLayer({
      id: "routes-underlay",
      type: "line",
      source: "gridpath-routes",
      paint: {
        "line-color": "#03080a",
        "line-width": ["case", selected, 12, 7],
        "line-opacity": ["case", selected, 0.98, 0.78],
      },
    } as maplibregl.LineLayerSpecification);
    instance.addLayer({
      id: "routes-centreline",
      type: "line",
      source: "gridpath-routes",
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["case", selected, 6, 3],
        "line-opacity": ["case", selected, 1, 0.62],
      },
    } as maplibregl.LineLayerSpecification);
  }, [
    alternatives,
    corridorGroups,
    mapReady,
    selectedCorridorKey,
    selectedPlan,
    selectedStrategy,
  ]);
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    ["selection-radius", "selection-points", "selection-labels"].forEach(
      (id) => {
        if (instance.getLayer(id)) instance.moveLayer(id);
      },
    );
  }, [alternatives, displayedEndpoints, mapReady, selectedStrategy]);
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    [
      "route-row-fill",
      "route-row-outline",
      "route-connector-underlay",
      "route-connectors",
      "routes-underlay",
      "routes-centreline",
    ].forEach((id) => {
      if (instance.getLayer(id))
        instance.setLayoutProperty(
          id,
          "visibility",
          corridorDesignVisible ? "visible" : "none",
        );
    });
  }, [corridorDesignVisible, mapReady, alternatives, selectedStrategy]);
  useEffect(() => {
    const instance = map.current;
    if (!instance || alternatives) return;
    const remove = (layers: string[], source: string) => {
      layers.forEach((id) => {
        if (instance.getLayer(id)) instance.removeLayer(id);
      });
      if (instance.getSource(source)) instance.removeSource(source);
    };
    remove(["route-row-fill", "route-row-outline"], "gridpath-route-corridor");
    remove(
      ["route-connector-underlay", "route-connectors"],
      "gridpath-route-connectors",
    );
    remove(["routes-underlay", "routes-centreline"], "gridpath-routes");
  }, [alternatives, mapReady]);
  useEffect(() => {
    if (alternatives && mapReady) focusAlternatives();
  }, [alternatives, focusAlternatives, mapReady]);
  const generateAlternatives = async () => {
    if (!scenario || planning || !readyToGenerate) return;
    setPlanning(true);
    setPlanError(null);
    try {
      const body: Record<string, unknown> = {
        scenario_id: "zurich-dietikon-urdorf-v1",
        building_clearance_m: clearance,
        right_of_way_width_m: rightOfWayWidth,
        strategy: "balanced",
      };
      if (
        userSelected &&
        draftEndpoints.grid_connection &&
        draftEndpoints.proposed_development
      ) {
        body.grid_connection = draftEndpoints.grid_connection;
        body.proposed_development = draftEndpoints.proposed_development;
      }
      const response = await fetch(`${apiBaseUrl}/api/plan/alternatives`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const responseBody = await response.json();
      if (!response.ok) {
        const detail = responseBody?.detail;
        throw new Error(
          detail?.message ??
            detail?.code ??
            `Planning request failed (${response.status})`,
        );
      }
      if (
        !Array.isArray(responseBody?.alternatives) ||
        responseBody.alternatives.length !== 3
      )
        throw new Error(
          "HTTP 200: alternatives response is missing route geometry",
        );
      const result = responseBody as AlternativesResponse;
      setAlternatives(result);
      setValidatedEndpoints(result.alternatives[0].selected_endpoints);
      setSelectedStrategy(
        result.alternatives.some(
          (alternative) => alternative.strategy === result.default_selection,
        )
          ? (result.default_selection as Strategy)
          : "shortest",
      );
      const defaultPlan = result.alternatives.find(
        (alternative) => alternative.strategy === result.default_selection,
      );
      setSelectedCorridorKey(
        corridorSignature(defaultPlan ?? result.alternatives[0]),
      );
      setPlacementMode(null);
      setViewMode(presentationMode.current);
    } catch (requestError) {
      setPlanError(
        requestError instanceof Error
          ? requestError.message
          : "Planning request failed",
      );
    } finally {
      setPlanning(false);
    }
  };
  const toggleLayer = (name: string) =>
    setVisibleLayers((current) => ({ ...current, [name]: !current[name] }));
  const overlapNote = (plan: PlanAlternative) =>
    [
      plan.strategy_note,
      ...Object.entries(plan.pairwise_overlap).map(
        ([strategy, value]) =>
          `${routeMeta[strategy as Strategy]?.label ?? strategy}: ${value}% shared`,
      ),
    ]
      .filter(Boolean)
      .join(" · ");
  if (selectedPlan)
    routeMeta[selectedPlan.strategy].note = selectedPlan.strategy_note;
  if (!scenario)
    return (
      <main className="app-shell">
        {error ? <div className="message error-message">{error}</div> : null}
      </main>
    );
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-location">Zürich</div>
        <div className="topbar-brand" aria-label="GridPath planning prototype">
          <span className="brand-grid">N!</span>
          <span>GridPath</span>
        </div>
        <div className="topbar-actions">
          <span className="status" title={scenario ? "Scenario loaded" : "Loading scenario"}>
            <i />
          </span>
          <button type="button" className="header-icon" title="Exit demo" aria-label="Exit demo">↗</button>
          <button type="button" className="header-icon" title="Planner profile" aria-label="Planner profile">◉</button>
        </div>
      </header>
      <section className="workspace">
        <aside className="agent-panel">
          <div className="agent-heading">
            <span className="agent-mark">GP</span>
            <div>
              <h2>N! Grid Connection Planner</h2>
              <p>Your agentic corridor planner</p>
            </div>
          </div>
          {error ? (
            <div className="message error-message">{error}</div>
          ) : !scenario ? (
            <div className="message">
              Loading prepared Zurich-region spatial layers…
            </div>
          ) : (
            <>
              <div className="connection-card">
                <span>Connection setup</span>
                <p>
                  Select two locations within 1 km. GridPath screens
                  street-based underground connection alternatives between them.
                </p>
                <div className="endpoint-actions">
                  <button
                    type="button"
                    onClick={() => startPlacement("grid_connection")}
                  >
                    Choose grid connection
                  </button>
                  <button
                    type="button"
                    onClick={() => startPlacement("proposed_development")}
                  >
                    Choose development
                  </button>
                  <button type="button" onClick={resetDemo}>
                    Reset demo points
                  </button>
                </div>
                <dl>
                  <div>
                    <dt>Current mode</dt>
                    <dd>{userSelected ? "User-selected" : "Demo points"}</dd>
                  </div>
                  <div>
                    <dt>Live straight-line distance</dt>
                    <dd className={overDistance ? "distance-error" : ""}>
                      {liveDistance === null
                        ? "Choose two points"
                        : `${Math.round(liveDistance)} m`}
                    </dd>
                  </div>
                  <div>
                    <dt>Maximum distance</dt>
                    <dd>1,000 m</dd>
                  </div>
                </dl>
                {placementMode === "grid_connection" ? (
                  <div className="placement-message">
                    Click the map to place the representative grid connection.
                    Press Escape to cancel.
                  </div>
                ) : placementMode === "proposed_development" ? (
                  <div className="placement-message">
                    Now click the map to place the proposed development. Press
                    Escape to cancel.
                  </div>
                ) : null}
                {overDistance ? (
                  <div className="endpoint-error">
                    Selected points are more than 1 km apart. Choose a closer
                    endpoint.
                  </div>
                ) : null}
              </div>
              <div className="intro-card">
                Place a representative connection and a proposed development.
                GridPath deterministically screens mapped street corridors and
                returns comparable planning alternatives.
              </div>
              <div className="constraint-card">
                <span>Prepared layers</span>
                <dl>
                  {Object.entries(layerLabels).map(([name, label]) => (
                    <div key={name}>
                      <dt>
                        <label>
                          <input
                            type="checkbox"
                            checked={visibleLayers[name]}
                            onChange={() => toggleLayer(name)}
                            disabled={
                              scenario.metadata.layer_counts[name] === 0
                            }
                          />{" "}
                          {label}
                        </label>
                      </dt>
                      <dd>{scenario.metadata.layer_counts[name]}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div className="constraint-card">
                <span>Engineering assumptions</span>
                <div className="assumption-fields">
                  <label>
                    Building clearance{" "}
                    <input
                      type="number"
                      min="10"
                      max="60"
                      value={clearance}
                      onChange={(event) =>
                        setClearance(Number(event.target.value))
                      }
                    />
                    <em>m</em>
                  </label>
                  <label>
                    Planning corridor width{" "}
                    <input
                      type="number"
                      min="2"
                      max="12"
                      value={rightOfWayWidth}
                      onChange={(event) =>
                        setRightOfWayWidth(Number(event.target.value))
                      }
                    />
                    <em>m</em>
                  </label>
                </div>
              </div>
              <button
                type="button"
                onClick={generateAlternatives}
                disabled={planning || !readyToGenerate}
              >
                {planning
                  ? "Generating alternatives…"
                  : "Evaluate corridor options"}
              </button>
              {planError ? (
                <div className="message error-message">{planError}</div>
              ) : null}
              {alternatives ? (
                <>
                  <div className="comparison-heading">
                    <span>
                      {strategiesConverged
                        ? "Recommended corridor"
                        : `${corridorGroups.length} UNIQUE CORRIDORS · 3 OBJECTIVES`}
                    </span>
                    <small>
                      {alternatives.candidate_count} deterministic candidates
                      screened
                    </small>
                  </div>
                  <div className="comparison-cards">
                    {corridorGroups.map((group) => {
                      const alternative = group.representative;
                      const combinedLabel = group.alternatives
                        .map((item) => routeMeta[item.strategy].label)
                        .join(" + ");
                      return (
                      <button
                        key={group.key}
                        type="button"
                        className={`comparison-card ${selectedCorridorKey === group.key ? "selected" : ""}`}
                        onClick={() => {
                          setSelectedCorridorKey(group.key);
                          setSelectedStrategy(alternative.strategy);
                        }}
                      >
                        <strong
                          style={{
                            color: routeMeta[alternative.strategy].color,
                          }}
                        >
                          {strategiesConverged
                            ? "Recommended corridor"
                            : combinedLabel}
                        </strong>
                        <span>
                          {alternative.route_length_m} m · rank{" "}
                          {alternative.candidate_rank}
                        </span>
                        <span>
                          {alternative.environmental_sensitivity_overlap_m2} m²
                          environmental overlap ·{" "}
                          {alternative.water_crossings_requiring_specialist_review} mapped water crossings requiring review
                        </span>
                        <span>
                          {alternative.turn_count} turns ·{" "}
                          {alternative.road_bridge_segments_m} m tagged bridge exposure ·{" "}
                          {alternative.road_tunnel_segments_m} m tagged tunnel exposure
                        </span>
                        <small>
                          {strategiesConverged
                            ? "All evaluated objectives agree on this corridor. Shortest · Lowest impact · Lowest complexity."
                            : group.alternatives
                                .map(
                                  (item) =>
                                    overlapNote(item) ||
                                    routeMeta[item.strategy].note,
                                )
                                .join(" · ")}
                        </small>
                      </button>
                      );
                    })}
                  </div>
                  {selectedPlan ? (
                    <div className="constraint-card result-card">
                      <span>
                        {strategiesConverged
                          ? "Recommended corridor"
                          : selectedCorridor?.alternatives
                              .map((item) => routeMeta[item.strategy].label)
                              .join(" + ")}{" "}
                        — detailed metrics
                      </span>
                      <dl>
                        <div>
                          <dt>Route length</dt>
                          <dd>{selectedPlan.route_length_m} m</dd>
                        </div>
                        <div>
                          <dt>Building conflicts</dt>
                          <dd>
                            {selectedPlan.buildings_intersecting_right_of_way}
                          </dd>
                        </div>
                        <div>
                          <dt>Environmental overlap</dt>
                          <dd>
                            {selectedPlan.environmental_sensitivity_overlap_m2}{" "}
                            m²
                          </dd>
                        </div>
                        <div>
                          <dt>Mapped water crossings requiring review</dt>
                          <dd>
                            {selectedPlan.water_crossings_requiring_specialist_review}
                          </dd>
                        </div>
                        <div>
                          <dt>Tagged road bridge exposure</dt>
                          <dd>
                            {selectedPlan.road_bridge_segments_m} m
                          </dd>
                        </div>
                        <div>
                          <dt>Tagged road tunnel exposure</dt>
                          <dd>
                            {selectedPlan.road_tunnel_segments_m} m
                          </dd>
                        </div>
                        <div>
                          <dt>Turns</dt>
                          <dd>{selectedPlan.turn_count}</dd>
                        </div>
                      </dl>
                      <p className="route-note">
                        {routeMeta[selectedPlan.strategy].note}
                      </p>
                    </div>
                  ) : null}
                </>
              ) : null}
              <p className="source-note">
                {scenario.metadata.source}
                <br />
                Retrieved {scenario.metadata.retrieved_at}
              </p>
              <p className="disclaimer">{scenario.metadata.disclaimer}</p>
            </>
          )}
        </aside>
        <MapErrorBoundary>
          <div className="map-stage">
            <div ref={mapContainer} className="map" />
            <div className="map-view-controls">
              <div className="view-toggle" role="group" aria-label="Map view">
                <button
                  type="button"
                  className={viewMode === "2d" ? "active" : ""}
                  onClick={() => setViewMode("2d")}
                >
                  2D
                </button>
                <button
                  type="button"
                  className={viewMode === "3d" ? "active" : ""}
                  onClick={() => setViewMode("3d")}
                >
                  3D
                </button>
              </div>
              {viewMode === "3d" ? (
                <div className="massing-label">
                  Google Photorealistic 3D · contextual visualization
                </div>
              ) : null}
            </div>
            <button
              className="focus-route"
              type="button"
              onClick={() =>
                alternatives ? focusAlternatives() : focusScenario()
              }
            >
              {alternatives ? "Focus alternatives" : "Focus study area"}
            </button>
            <div className="legend corridor-pills">
              <button
                type="button"
                className="corridor-toggle"
                onClick={() => setCorridorDesignVisible((visible) => !visible)}
              >
                {corridorDesignVisible
                  ? "Hide corridor design"
                  : "Show corridor design"}
              </button>
              <span><i className="route-shortest" /> Recommended corridor</span>
              <span><i className="row" /> Right-of-way</span>
              <span><i className="origin" /> Grid connection</span>
              <span><i className="destination" /> Proposed development</span>
              <span><i className="connector" /> Synthetic connectors</span>
              <span><i className="constraints" /> Visible constraints</span>
            </div>
          </div>
        </MapErrorBoundary>
      </section>
    </main>
  );
}
export default App;
