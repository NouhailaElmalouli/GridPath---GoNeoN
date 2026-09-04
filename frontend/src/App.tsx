import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { loadGoogleMaps3D } from "./google3d";
import { MapErrorBoundary } from "./MapErrorBoundary";

// Vite's production bundle needs an explicit GeoJSON worker asset.  Raster
// tiles can render without it, but all dynamic GeoJSON sources depend on it.
maplibregl.setWorkerUrl(maplibreWorkerUrl);

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
  major_road_exposure_m: number;
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
type OfficialContext = GeoJSON.FeatureCollection & {
  properties: {
    provenance: Record<string, unknown>;
    operator_territory: Record<string, string>;
    disclaimer: string;
    feature_counts: Record<string, number>;
  };
};
type OfficialAsset = GeoJSON.Feature<GeoJSON.Point, Record<string, unknown>>;

const viteEnv = (
  import.meta as ImportMeta & { env?: Record<string, string> }
).env;
const apiBaseUrl = (
  (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_API_BASE_URL ?? ""
).replace(/\/$/, "");
const googleMapsKey = viteEnv?.VITE_GOOGLE_MAPS_API_KEY;
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
function officialAssetStatusLabel(value: unknown): string {
  const status = String(value ?? "Not published");
  return status === "bestehend" ? "Existing" : status;
}
function officialAssetKindLabel(value: unknown): string {
  const kind = String(value ?? "Published asset");
  if (kind === "Wasserkraftwerk") return "Hydroelectric plant";
  if (kind === "Unterwerk") return "Substation";
  return kind;
}
function officialAssetClassification(properties: Record<string, unknown>): string {
  return `${officialAssetStatusLabel(properties.status)} ${officialAssetKindLabel(properties.kind).toLowerCase()}`;
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
  const presentationMode = useRef<ViewMode>("3d");
  const [mapReady, setMapReady] = useState(false);
  const [styleRevision, setStyleRevision] = useState(0);
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
  const [viewMode, setViewMode] = useState<ViewMode>("3d");
  const [placementMode, setPlacementMode] = useState<PlacementMode>(null);
  const [draftEndpoints, setDraftEndpoints] = useState<Endpoints>({});
  const [validatedEndpoints, setValidatedEndpoints] = useState<Endpoints>({});
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [clearance, setClearance] = useState(25);
  // Compact analytical ribbon, not a construction specification.
  const [rightOfWayWidth, setRightOfWayWidth] = useState(4);
  const [corridorDesignVisible, setCorridorDesignVisible] = useState(true);
  const [visibleStrategies, setVisibleStrategies] = useState<Record<Strategy, boolean>>({
    shortest: true,
    environmental: true,
    constructability: true,
  });
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [officialContext, setOfficialContext] = useState<OfficialContext | null>(null);
  const [officialContextVisible, setOfficialContextVisible] = useState(false);
  const [selectedOfficialAsset, setSelectedOfficialAsset] =
    useState<OfficialAsset | null>(null);
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
  const shortestPlan = useMemo(
    () => alternatives?.alternatives.find((item) => item.strategy === "shortest") ?? null,
    [alternatives],
  );
  const cardTradeoff = useCallback(
    (plan: PlanAlternative): string => {
      if (plan.strategy === "shortest") return "Fastest connection.";
      if (!shortestPlan) return routeMeta[plan.strategy].note;
      const lengthDelta = plan.route_length_m - shortestPlan.route_length_m;
      const lengthText = `${lengthDelta >= 0 ? "+" : ""}${lengthDelta.toFixed(1)} m`;
      if (plan.strategy === "environmental") {
        const overlapReduction =
          shortestPlan.environmental_sensitivity_overlap_m2 -
          plan.environmental_sensitivity_overlap_m2;
        return overlapReduction > 0
          ? `${overlapReduction.toFixed(1)} m² less environmental overlap · ${lengthText}.`
          : `No lower environmental overlap · ${lengthText}.`;
      }
      const turnReduction = shortestPlan.turn_count - plan.turn_count;
      return turnReduction > 0
        ? `${turnReduction} fewer turns · ${lengthText}.`
        : `No fewer turns · ${lengthText}.`;
    },
    [shortestPlan],
  );
  const visibleCorridorGroups = useMemo(
    () =>
      corridorGroups.filter((group) =>
        group.alternatives.some((item) => visibleStrategies[item.strategy]),
      ),
    [corridorGroups, visibleStrategies],
  );
  const selectedRouteVisible = Boolean(
    selectedCorridor?.alternatives.some(
      (item) => visibleStrategies[item.strategy],
    ),
  );
  useEffect(() => {
    let cancelled = false;
    fetch("/official-grid-context.geojson")
      .then((response) => {
        if (!response.ok) throw new Error("Official context asset could not be loaded");
        return response.json();
      })
      .then((value: OfficialContext) => {
        if (!cancelled) setOfficialContext(value);
      })
      .catch(() => {
        // The planning workflow remains fully usable if this optional context is unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const userSelected = Boolean(
    draftEndpoints.grid_connection || draftEndpoints.proposed_development,
  );
  const liveDistance = distanceMeters(
    draftEndpoints.grid_connection,
    draftEndpoints.proposed_development,
  );
  const overDistance = liveDistance !== null && liveDistance > 1000;
  const readyToGenerate = Boolean(
    draftEndpoints.grid_connection && draftEndpoints.proposed_development,
  ) && !overDistance;
  const displayedEndpoints =
    alternatives && selectedPlan
      ? Object.keys(validatedEndpoints).length
        ? validatedEndpoints
        : selectedPlan.selected_endpoints
      : draftEndpoints;
  const officialPointAssets = useMemo(
    () =>
      officialContext?.features.filter(
        (feature): feature is OfficialAsset => feature.geometry?.type === "Point",
      ) ?? [],
    [officialContext],
  );
  const nearestOfficialPointAsset = useMemo(() => {
    const pointA = displayedEndpoints.grid_connection;
    if (!pointA) return null;
    return officialPointAssets
      .map((feature) => ({
        feature,
        distance: distanceMeters(pointA, feature.geometry as GeoPoint) ?? Infinity,
      }))
      .sort((a, b) => a.distance - b.distance)[0] ?? null;
  }, [displayedEndpoints.grid_connection, officialPointAssets]);
  const selectedOfficialDistances = useMemo(() => {
    if (!selectedOfficialAsset) return null;
    return {
      pointA: distanceMeters(
        displayedEndpoints.grid_connection,
        selectedOfficialAsset.geometry as GeoPoint,
      ),
      pointB: distanceMeters(
        displayedEndpoints.proposed_development,
        selectedOfficialAsset.geometry as GeoPoint,
      ),
    };
  }, [displayedEndpoints, selectedOfficialAsset]);
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
    const officialBounds =
      officialContextVisible && nearestOfficialPointAsset
        ? boundsFromCoordinates([
          nearestOfficialPointAsset.feature.geometry.coordinates,
        ])
        : null;
    fitMap(
      [
        [
          Math.min(routeBounds[0][0], endpointBounds[0][0], officialBounds?.[0][0] ?? Infinity),
          Math.min(routeBounds[0][1], endpointBounds[0][1], officialBounds?.[0][1] ?? Infinity),
        ],
        [
          Math.max(routeBounds[1][0], endpointBounds[1][0], officialBounds?.[1][0] ?? -Infinity),
          Math.max(routeBounds[1][1], endpointBounds[1][1], officialBounds?.[1][1] ?? -Infinity),
        ],
      ],
      16.1,
    );
  }, [alternatives, displayedEndpoints, fitMap, scenario, officialContextVisible, nearestOfficialPointAsset]);
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
    setDraftEndpoints((current) => {
      const next = { ...current };
      delete next[mode];
      return next;
    });
  };
  const clearPoints = () => {
    setPlacementMode(null);
    setDraftEndpoints({});
    clearResults();
    setPlanError(null);
  };
  const placeMapPoint = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest(".maplibregl-ctrl")) return;
    const activePlacement =
      placementMode ??
      (!draftEndpoints.grid_connection
        ? "grid_connection"
        : !draftEndpoints.proposed_development
          ? "proposed_development"
          : null);
    if (!activePlacement || !map.current || !mapContainer.current) return;
    const bounds = mapContainer.current.getBoundingClientRect();
    const lngLat = map.current.unproject([
      event.clientX - bounds.left,
      event.clientY - bounds.top,
    ]);
    const point: GeoPoint = {
      type: "Point",
      coordinates: [lngLat.lng, lngLat.lat],
    };
    clearResults();
    setPlanError(null);
    if (activePlacement === "grid_connection") {
      setDraftEndpoints({ grid_connection: point });
      setPlacementMode("proposed_development");
    } else {
      setDraftEndpoints((current) => ({ ...current, proposed_development: point }));
      setPlacementMode(null);
    }
  }, [clearResults, draftEndpoints, placementMode]);
  const syncDynamicOverlayLayerOrder = useCallback((instance: MapLibreMap) => {
    [
      "route-row-fill", "route-row-outline", "route-connector-underlay",
      "route-connectors", "routes-underlay", "routes-centreline",
      "selection-radius", "selection-points", "selection-labels",
    ].forEach((id) => {
      if (instance.getLayer(id)) instance.moveLayer(id);
    });
  }, []);
  const ensureDynamicOverlaySourcesAndLayers = useCallback((instance: MapLibreMap) => {
    const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
    const ensureSource = (id: string) => {
      if (!instance.getSource(id)) instance.addSource(id, { type: "geojson", data: empty });
    };
    ["gridpath-selection", "gridpath-radius", "gridpath-routes", "gridpath-route-corridor", "gridpath-route-connectors"].forEach(ensureSource);
    if (!instance.getLayer("route-row-fill")) instance.addLayer({ id: "route-row-fill", type: "fill", source: "gridpath-route-corridor", paint: { "fill-color": "#22e7f0", "fill-opacity": 0.16 } });
    if (!instance.getLayer("route-row-outline")) instance.addLayer({ id: "route-row-outline", type: "line", source: "gridpath-route-corridor", paint: { "line-color": "#22e7f0", "line-width": 1.5, "line-opacity": 0.82 } } as maplibregl.LineLayerSpecification);
    if (!instance.getLayer("route-connector-underlay")) instance.addLayer({ id: "route-connector-underlay", type: "line", source: "gridpath-route-connectors", paint: { "line-color": "#05090d", "line-width": 7, "line-opacity": 0.95 } } as maplibregl.LineLayerSpecification);
    if (!instance.getLayer("route-connectors")) instance.addLayer({ id: "route-connectors", type: "line", source: "gridpath-route-connectors", paint: { "line-color": "#22e7f0", "line-width": 2.5, "line-opacity": 1, "line-dasharray": [2, 1.5] } } as maplibregl.LineLayerSpecification);
    if (!instance.getLayer("routes-underlay")) instance.addLayer({ id: "routes-underlay", type: "line", source: "gridpath-routes", paint: { "line-color": "#03080a", "line-width": 9, "line-opacity": 0.78 } } as maplibregl.LineLayerSpecification);
    if (!instance.getLayer("routes-centreline")) instance.addLayer({ id: "routes-centreline", type: "line", source: "gridpath-routes", paint: { "line-color": ["get", "color"], "line-width": 4, "line-opacity": 0.76 } } as maplibregl.LineLayerSpecification);
    if (!instance.getLayer("selection-radius")) instance.addLayer({ id: "selection-radius", type: "line", source: "gridpath-radius", paint: { "line-color": "#25f4d0", "line-width": 1.5, "line-opacity": 0.6, "line-dasharray": [2, 2] } } as maplibregl.LineLayerSpecification);
    if (!instance.getLayer("selection-points")) instance.addLayer({ id: "selection-points", type: "circle", source: "gridpath-selection", paint: { "circle-radius": 7, "circle-color": ["match", ["get", "endpoint_id"], "grid_connection", "#25f4d0", "#f044b7"], "circle-stroke-color": "#071014", "circle-stroke-width": 2.4 } });
    if (!instance.getLayer("selection-labels")) instance.addLayer({ id: "selection-labels", type: "symbol", source: "gridpath-selection", layout: { "text-field": ["match", ["get", "endpoint_id"], "grid_connection", "Point A", "Point B"], "text-size": 10, "text-offset": [0, -1.45], "text-allow-overlap": true }, paint: { "text-color": "#eaf5fb", "text-halo-color": "#071014", "text-halo-width": 1.25 } } as maplibregl.SymbolLayerSpecification);
    syncDynamicOverlayLayerOrder(instance);
  }, [syncDynamicOverlayLayerOrder]);

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
    const onLoad = () => setMapReady(true);
    const onStyleLoad = () => setStyleRevision((revision) => revision + 1);
    instance.on("load", onLoad);
    instance.on("style.load", onStyleLoad);
    return () => {
      instance.off("load", onLoad);
      instance.off("style.load", onStyleLoad);
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
          // SATELLITE keeps the photorealistic context without provider POI labels.
          mode: "SATELLITE",
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
            // Google Maps 3D uses pixel stroke widths; outerWidth is a fraction.
            outerWidth: width >= 8 ? 0.5 : width >= 3 ? 0.42 : 0.2,
            strokeColor: color,
            strokeWidth: width >= 8 ? 9 : width >= 3 ? 5 : 1,
            zIndex: width >= 8 ? 20 : 10,
          }),
        );
      };
      // Deliberately omit the study-area outline in photorealistic 3D: it is
      // available in 2D but distracts from the corridor comparison here.
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
              ? "Point A"
              : "Point B",
          });
          marker.dataset.gridpathEndpoint = "true";
          marker.append(
            new PinElement({
              background: isGrid ? "#25f4d0" : "#ff3ca6",
              borderColor: "#081014",
              glyphColor: "#081014",
              glyphText: isGrid ? "A" : "B",
              scale: 1.15,
            }),
          );
          googleEndpointMarkers.current.push(marker);
          add(marker);
        });
      if (officialContextVisible && Marker3DElement && PinElement)
        officialPointAssets.forEach((feature) => {
          const [lng, lat] = feature.geometry.coordinates;
          const kind = String(feature.properties.kind ?? "Official asset");
          const isSelected =
            feature.properties.official_id === selectedOfficialAsset?.properties.official_id;
          const marker = new Marker3DElement({
            position: { lat, lng },
            altitudeMode: "CLAMP_TO_GROUND",
            collisionBehavior: "OPTIONAL_AND_HIDES_LOWER_PRIORITY",
            title: `${kind}: ${String(feature.properties.name ?? "Unnamed")}`,
          });
          marker.dataset.gridpathOfficial = "true";
          marker.append(
            new PinElement({
              background: isSelected ? "#d8c5f4" : "#8061b5",
              borderColor: isSelected ? "#ffffff" : "#160f24",
              glyphColor: isSelected ? "#160f24" : "#f3effa",
              glyphText: kind === "Unterwerk" ? "S" : "H",
              scale: isSelected ? 1.02 : 0.72,
            }),
          );
          marker.addEventListener("gmp-click", () => setSelectedOfficialAsset(feature));
          add(marker);
        });
      if (officialContextVisible && officialContext && library.Polyline3DElement)
        officialContext.features.forEach((feature) => {
          if (feature.geometry.type !== "MultiLineString") return;
          const isCable = feature.properties?.installation === "Kabelleitung";
          feature.geometry.coordinates.forEach((line) =>
            add(
              new library.Polyline3DElement({
                path: line.map(([lng, lat]) => ({ lat, lng, altitude: 1.5 })),
                altitudeMode: "RELATIVE_TO_GROUND",
                drawsOccludedSegments: true,
                outerColor: "#1d142b",
                outerWidth: 0.5,
                strokeColor: isCable ? "#a783dd" : "#8b6cc4",
                strokeWidth: isCable ? 6 : 5,
                zIndex: 4,
              }),
            ),
          );
        });
      if (!alternatives || !selectedPlan || !corridorDesignVisible) return;
      for (const group of visibleCorridorGroups)
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
          `${Math.max(
            officialContextVisible ? 2300 : 1900,
            Math.min(officialContextVisible ? 3600 : 3000, span * 220000),
          )}`,
        );
        scene.setAttribute("tilt", "55");
        scene.setAttribute("heading", "-28");
      }
      if (selectedRouteVisible && selectedPlan.right_of_way.type === "Polygon") {
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
      if (selectedRouteVisible)
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
    selectedRouteVisible,
    visibleCorridorGroups,
    officialContextVisible,
    officialContext,
    officialPointAssets,
    selectedOfficialAsset,
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
      { "line-color": "#061015", "line-width": 1, "line-opacity": 0.3 },
    );
    layer(
      "scenario-study-area-outline",
      "line",
      ["==", ["get", "layer"], "study_area"],
      {
        "line-color": "#25f4d0",
        "line-width": 0.55,
        "line-opacity": 0.48,
        "line-dasharray": [1.2, 2],
      },
    );
    // Scenario layers are asynchronous relative to map load; restore the
    // analysis overlays after they have been appended.
    ensureDynamicOverlaySourcesAndLayers(instance);
    syncDynamicOverlayLayerOrder(instance);
  }, [ensureDynamicOverlaySourcesAndLayers, mapReady, scenario, styleRevision, syncDynamicOverlayLayerOrder]);
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
  }, [scenario, styleRevision, viewMode, visibleLayers]);
  useEffect(() => {
    if (!mapReady || !map.current) return;
    const instance = map.current;
    const layerIds = [
      "official-grid-cables",
      "official-grid-overhead",
      "official-grid-substations",
      "official-grid-hydro",
      "official-grid-selected-halo",
    ];
    layerIds.forEach((id) => {
      if (instance.getLayer(id)) instance.removeLayer(id);
    });
    if (instance.getSource("official-grid-context"))
      instance.removeSource("official-grid-context");
    if (!officialContext || !officialContextVisible) return;
    instance.addSource("official-grid-context", {
      type: "geojson",
      data: officialContext,
    });
    const before = instance.getLayer("routes-underlay") ? "routes-underlay" : undefined;
    const selectedOfficialId = Number(selectedOfficialAsset?.properties.official_id ?? -1);
    instance.addLayer({
      id: "official-grid-cables",
      type: "line",
      source: "official-grid-context",
      filter: ["==", ["get", "installation"], "Kabelleitung"],
      paint: {
        "line-color": "#a783dd",
        "line-width": 5.5,
        "line-opacity": ["case", ["==", ["get", "status"], "Geplant"], 0.5, 0.92],
        "line-dasharray": [1.4, 1.2],
      },
    } as maplibregl.LineLayerSpecification, before);
    instance.addLayer({
      id: "official-grid-overhead",
      type: "line",
      source: "official-grid-context",
      filter: ["==", ["get", "installation"], "Freileitung"],
      paint: {
        "line-color": "#8b6cc4",
        "line-width": 4.2,
        "line-opacity": ["case", ["==", ["get", "status"], "Geplant"], 0.5, 0.86],
      },
    } as maplibregl.LineLayerSpecification, before);
    instance.addLayer({
      id: "official-grid-substations",
      type: "circle",
      source: "official-grid-context",
      filter: ["==", ["get", "kind"], "Unterwerk"],
      paint: {
        "circle-radius": ["case", ["==", ["get", "official_id"], selectedOfficialId], 8, 5.5],
        "circle-color": ["case", ["==", ["get", "official_id"], selectedOfficialId], "#d8c5f4", "#8061b5"],
        "circle-stroke-color": ["case", ["==", ["get", "official_id"], selectedOfficialId], "#ffffff", "#150f22"],
        "circle-stroke-width": ["case", ["==", ["get", "official_id"], selectedOfficialId], 2.5, 1.6],
      },
    } as maplibregl.CircleLayerSpecification, before);
    instance.addLayer({
      id: "official-grid-hydro",
      type: "circle",
      source: "official-grid-context",
      filter: ["==", ["get", "kind"], "Wasserkraftwerk"],
      paint: {
        "circle-radius": ["case", ["==", ["get", "official_id"], selectedOfficialId], 8, 5],
        "circle-color": ["case", ["==", ["get", "official_id"], selectedOfficialId], "#d8c5f4", "#a686d4"],
        "circle-stroke-color": ["case", ["==", ["get", "official_id"], selectedOfficialId], "#ffffff", "#150f22"],
        "circle-stroke-width": ["case", ["==", ["get", "official_id"], selectedOfficialId], 2.5, 1.6],
      },
    } as maplibregl.CircleLayerSpecification, before);
    instance.addLayer({
      id: "official-grid-selected-halo",
      type: "circle",
      source: "official-grid-context",
      filter: ["==", ["get", "official_id"], selectedOfficialId],
      paint: {
        "circle-radius": 13,
        "circle-color": "#d8c5f4",
        "circle-opacity": 0.2,
        "circle-stroke-color": "#d8c5f4",
        "circle-stroke-width": 1.5,
        "circle-stroke-opacity": 0.85,
      },
    } as maplibregl.CircleLayerSpecification, before);
    const selectAsset = (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (feature?.geometry.type === "Point")
        setSelectedOfficialAsset(feature as OfficialAsset);
    };
    instance.on("click", "official-grid-substations", selectAsset);
    instance.on("click", "official-grid-hydro", selectAsset);
    const pointLayers = ["official-grid-substations", "official-grid-hydro"] as const;
    const showPointer = () => {
      instance.getCanvas().style.cursor = "pointer";
    };
    const clearPointer = () => {
      instance.getCanvas().style.cursor = "";
    };
    pointLayers.forEach((layer) => {
      instance.on("mouseenter", layer, showPointer);
      instance.on("mouseleave", layer, clearPointer);
    });
    return () => {
      instance.off("click", "official-grid-substations", selectAsset);
      instance.off("click", "official-grid-hydro", selectAsset);
      pointLayers.forEach((layer) => {
        instance.off("mouseenter", layer, showPointer);
        instance.off("mouseleave", layer, clearPointer);
      });
    };
  }, [mapReady, officialContext, officialContextVisible, selectedOfficialAsset, styleRevision]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPlacementMode(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => {
    if (map.current)
      map.current.getCanvas().style.cursor =
        placementMode || !draftEndpoints.grid_connection || !draftEndpoints.proposed_development
          ? "crosshair"
          : "";
  }, [draftEndpoints, placementMode]);
  useEffect(() => {
    if (!mapReady || !map.current) return;
    const instance = map.current;
    ensureDynamicOverlaySourcesAndLayers(instance);
    const endpoints = Object.entries(displayedEndpoints).filter(
      (entry): entry is [string, GeoPoint] => Boolean(entry[1]),
    );
    const selection: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: endpoints.map(([id, point]) => ({
        type: "Feature",
        properties: { endpoint_id: id },
        geometry: point,
      })),
    };
    const selectionSource = instance.getSource("gridpath-selection") as
      | maplibregl.GeoJSONSource
      | undefined;
    if (selectionSource) selectionSource.setData(selection);
    else instance.addSource("gridpath-selection", { type: "geojson", data: selection });
    if (!instance.getLayer("selection-points"))
      instance.addLayer({
        id: "selection-points", type: "circle", source: "gridpath-selection",
        paint: {
          "circle-radius": 7,
          "circle-color": ["match", ["get", "endpoint_id"], "grid_connection", "#25f4d0", "#f044b7"],
          "circle-stroke-color": "#071014", "circle-stroke-width": 2.4,
        },
      });
    if (!instance.getLayer("selection-labels"))
      instance.addLayer({
        id: "selection-labels",
        type: "symbol",
        source: "gridpath-selection",
        layout: {
          "text-field": ["match", ["get", "endpoint_id"], "grid_connection", "Point A", "Point B"],
          "text-size": 10,
          "text-offset": [0, -1.45],
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": "#eaf5fb",
          "text-halo-color": "#071014",
          "text-halo-width": 1.25,
        },
      } as maplibregl.SymbolLayerSpecification);
    instance.setLayoutProperty(
      "selection-labels",
      "visibility",
      endpoints.length === 2 ? "visible" : "none",
    );
    const radius: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: placementMode === "proposed_development" && draftEndpoints.grid_connection
        ? [circleFeature(draftEndpoints.grid_connection)]
        : [],
    };
    const radiusSource = instance.getSource("gridpath-radius") as
      | maplibregl.GeoJSONSource
      | undefined;
    if (radiusSource) radiusSource.setData(radius);
    else instance.addSource("gridpath-radius", { type: "geojson", data: radius });
    if (!instance.getLayer("selection-radius"))
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
    ["selection-radius", "selection-points", "selection-labels"].forEach((id) =>
      instance.moveLayer(id),
    );
  }, [
    displayedEndpoints,
    draftEndpoints.grid_connection,
    ensureDynamicOverlaySourcesAndLayers,
    mapReady,
    placementMode,
    styleRevision,
  ]);
  useEffect(() => {
    if (!mapReady || !map.current) return;
    const instance = map.current;
    ensureDynamicOverlaySourcesAndLayers(instance);
    const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
    const asFeatures = (
      geometry: GeoJSON.Geometry,
    ): GeoJSON.FeatureCollection => ({
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry }],
    });
    const routes: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: (alternatives ? visibleCorridorGroups : []).map((group) => ({
        type: "Feature",
        properties: {
          corridor_key: group.key,
          color: routeMeta[group.representative.strategy].color,
        },
        geometry: group.representative.centreline,
      })),
    };
    const updateSource = (id: string, data: GeoJSON.FeatureCollection) => {
      const source = instance.getSource(id) as maplibregl.GeoJSONSource | undefined;
      if (source) source.setData(data);
      else instance.addSource(id, { type: "geojson", data });
    };
    updateSource("gridpath-routes", routes);
    updateSource(
      "gridpath-route-corridor",
      selectedPlan && selectedRouteVisible ? asFeatures(selectedPlan.right_of_way) : empty,
    );
    updateSource(
      "gridpath-route-connectors",
      selectedPlan && selectedRouteVisible ? selectedPlan.endpoint_connectors : empty,
    );
    const selected = [
      "==",
      ["get", "corridor_key"],
      selectedCorridorKey,
    ] as unknown as maplibregl.ExpressionSpecification;
    if (!instance.getLayer("route-row-fill")) instance.addLayer({
      id: "route-row-fill",
      type: "fill",
      source: "gridpath-route-corridor",
      paint: {
        "fill-color": routeMeta[selectedStrategy].color,
        "fill-opacity": 0.16,
      },
    });
    if (!instance.getLayer("route-row-outline")) instance.addLayer({
      id: "route-row-outline",
      type: "line",
      source: "gridpath-route-corridor",
      paint: {
        "line-color": routeMeta[selectedStrategy].color,
        "line-width": 1.5,
        "line-opacity": 0.82,
      },
    } as maplibregl.LineLayerSpecification);
    if (!instance.getLayer("route-connector-underlay")) instance.addLayer({
      id: "route-connector-underlay",
      type: "line",
      source: "gridpath-route-connectors",
      paint: { "line-color": "#05090d", "line-width": 7, "line-opacity": 0.95 },
    } as maplibregl.LineLayerSpecification);
    if (!instance.getLayer("route-connectors")) instance.addLayer({
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
    if (!instance.getLayer("routes-underlay")) instance.addLayer({
      id: "routes-underlay",
      type: "line",
      source: "gridpath-routes",
      paint: {
        "line-color": "#03080a",
        "line-width": ["case", selected, 14, 9],
        "line-opacity": ["case", selected, 0.98, 0.78],
      },
    } as maplibregl.LineLayerSpecification);
    if (!instance.getLayer("routes-centreline")) instance.addLayer({
      id: "routes-centreline",
      type: "line",
      source: "gridpath-routes",
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["case", selected, 8, 4],
        "line-opacity": ["case", selected, 1, 0.76],
      },
    } as maplibregl.LineLayerSpecification);
    instance.setPaintProperty("routes-underlay", "line-width", ["case", selected, 14, 9]);
    instance.setPaintProperty("routes-underlay", "line-opacity", ["case", selected, 0.98, 0.78]);
    instance.setPaintProperty("routes-centreline", "line-width", ["case", selected, 8, 4]);
    instance.setPaintProperty("routes-centreline", "line-opacity", ["case", selected, 1, 0.76]);
    instance.setPaintProperty("route-row-fill", "fill-color", routeMeta[selectedStrategy].color);
    instance.setPaintProperty("route-row-outline", "line-color", routeMeta[selectedStrategy].color);
    instance.setPaintProperty("route-connectors", "line-color", routeMeta[selectedStrategy].color);
    syncDynamicOverlayLayerOrder(instance);
  }, [
    alternatives,
    corridorGroups,
    ensureDynamicOverlaySourcesAndLayers,
    mapReady,
    selectedCorridorKey,
    selectedPlan,
    selectedRouteVisible,
    selectedStrategy,
    styleRevision,
    syncDynamicOverlayLayerOrder,
    visibleCorridorGroups,
  ]);
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    ["selection-radius", "selection-points", "selection-labels"].forEach(
      (id) => {
        if (instance.getLayer(id)) instance.moveLayer(id);
      },
    );
  }, [alternatives, displayedEndpoints, mapReady, selectedStrategy, styleRevision]);
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
  }, [corridorDesignVisible, mapReady, alternatives, selectedStrategy, styleRevision]);
  useEffect(() => {
    if (alternatives && mapReady) focusAlternatives();
  }, [alternatives, focusAlternatives, mapReady]);
  const generateAlternatives = async () => {
    if (!scenario || planning || !readyToGenerate) return;
    setPlanning(true);
    setPlanError(null);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const body: Record<string, unknown> = {
        scenario_id: "zurich-dietikon-urdorf-v1",
        building_clearance_m: clearance,
        right_of_way_width_m: rightOfWayWidth,
        strategy: "balanced",
      };
      // Generation is disabled until both points exist, so frontend planning
      // always sends the explicit user-selected WGS84 points.
      body.grid_connection = draftEndpoints.grid_connection;
      body.proposed_development = draftEndpoints.proposed_development;
      const response = await fetch(`${apiBaseUrl}/api/plan/alternatives`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
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
        responseBody.alternatives.length < 1 ||
        responseBody.alternatives.length > 3
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
        requestError instanceof DOMException && requestError.name === "AbortError"
          ? "Planning timed out. Try points closer to the prepared road network."
          : requestError instanceof TypeError
            ? "Network request failed. Check that the planning service is available."
            : requestError instanceof Error
              ? requestError.message
              : "Planning request failed",
      );
    } finally {
      window.clearTimeout(timeoutId);
      setPlanning(false);
    }
  };
  const exportAssessment = () => {
    if (!alternatives || !selectedPlan || !scenario) return;
    const endpointFeature = (id: string, point: GeoPoint | undefined) =>
      point
        ? {
          type: "Feature" as const,
          properties: {
            feature_type: "selected_endpoint",
            endpoint_id: id,
            display_label: id === "grid_connection" ? "Point A" : "Point B",
          },
          geometry: point,
        }
        : null;
    const routeFeatures = alternatives.alternatives.map((plan) => ({
      type: "Feature" as const,
      properties: {
        feature_type: "route_centreline",
        strategy: plan.strategy,
        strategy_label: routeMeta[plan.strategy].label,
        strategy_explanation: cardTradeoff(plan),
        route_length_m: plan.route_length_m,
        environmental_overlap_m2: plan.environmental_sensitivity_overlap_m2,
        water_review_crossings: plan.water_crossings_requiring_specialist_review,
        bridge_exposure_m: plan.road_bridge_segments_m,
        tunnel_exposure_m: plan.road_tunnel_segments_m,
        major_road_exposure_m: plan.major_road_exposure_m,
        turns: plan.turn_count,
        candidate_rank: plan.candidate_rank,
      },
      geometry: plan.centreline,
    }));
    const connectorFeatures = selectedPlan.endpoint_connectors.features.map(
      (feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          feature_type: "synthetic_endpoint_connector",
          strategy: selectedPlan.strategy,
        },
      }),
    );
    const snappedFeatures = Object.entries(selectedPlan.snapped_road_points).map(
      ([id, point]) => ({
        type: "Feature" as const,
        properties: { feature_type: "snapped_road_point", endpoint_id: id },
        geometry: point,
      }),
    );
    const officialFeatures =
      officialContextVisible && officialContext
        ? officialContext.features.map((feature) => ({
          ...feature,
          properties: {
            ...feature.properties,
            feature_type: "official_grid_context",
          },
        }))
        : [];
    const featureCollection: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        ...Object.entries(selectedPlan.selected_endpoints)
          .map(([id, point]) => endpointFeature(id, point))
          .filter(Boolean),
        ...routeFeatures,
        {
          type: "Feature",
          properties: {
            feature_type: "selected_right_of_way",
            strategy: selectedPlan.strategy,
          },
          geometry: selectedPlan.right_of_way,
        },
        ...connectorFeatures,
        ...snappedFeatures,
        ...officialFeatures,
      ],
      properties: {
        study_area_identifier: scenario.metadata.scenario_name,
        source: scenario.metadata.source,
        generation_timestamp: new Date().toISOString(),
        planning_assumptions: {
          building_clearance_m: clearance,
          right_of_way_width_m: rightOfWayWidth,
          endpoint_mode: selectedPlan.endpoint_mode,
        },
        official_grid_context: officialContext
          ? {
            displayed_in_export: officialContextVisible,
            operator_territory: officialContext.properties.operator_territory,
            nearest_published_asset: nearestOfficialPointAsset
              ? {
                name: nearestOfficialPointAsset.feature.properties.name,
                distance_from_point_a_m: Math.round(nearestOfficialPointAsset.distance),
              }
              : null,
            provenance: officialContext.properties.provenance,
            disclaimer: officialContext.properties.disclaimer,
          }
          : null,
        disclaimer:
          "Planning prototype only. This assessment is not a regulatory-compliance determination or construction-ready alignment.",
      },
    } as GeoJSON.FeatureCollection;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(featureCollection, null, 2)], {
        type: "application/geo+json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "gridpath-corridor-assessment.geojson";
    link.click();
    URL.revokeObjectURL(url);
    setExportMessage("Assessment exported as GeoJSON.");
  };
  const toggleLayer = (name: string) =>
    setVisibleLayers((current) => ({ ...current, [name]: !current[name] }));
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
          <button type="button" className="header-icon" title="Planner profile" aria-label="Planner profile">◎</button>
        </div>
      </header>
      <section className="workspace">
        <aside className="agent-panel">
          <div className="agent-heading">
            <span className="agent-mark">GP</span>
            <div>
              <h2>N! GridPath</h2>
              <p>Infrastructure corridor screening</p>
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
                  Select any two planning locations within 1 km. GridPath compares
                  evidence-based underground corridor options between them.
                </p>
                <div className="endpoint-actions">
                  <button
                    type="button"
                    onClick={() => startPlacement("grid_connection")}
                  >
                    Choose Point A
                  </button>
                  <button
                    type="button"
                    onClick={() => startPlacement("proposed_development")}
                  >
                    Choose Point B
                  </button>
                  <button type="button" onClick={clearPoints}>
                    Clear points
                  </button>
                </div>
                <dl>
                  <div>
                    <dt>Current mode</dt>
                    <dd>{userSelected ? "User-selected" : "Choose Point A and Point B"}</dd>
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
                    Click the map to place Point A.
                    Press Escape to cancel.
                  </div>
                ) : placementMode === "proposed_development" ? (
                  <div className="placement-message">
                    Now click the map to place Point B. Press
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
              {officialContext ? (
                <div className="constraint-card official-context-card">
                  <details>
                    <summary>Official context</summary>
                    <dl>
                      <div><dt>Network operator</dt><dd>EKZ</dd></div>
                      <div><dt>Published assets in study area</dt><dd>0</dd></div>
                      <div><dt>Published assets within 2 km</dt><dd>24</dd></div>
                    </dl>
                    {nearestOfficialPointAsset ? (
                      <p>
                        <strong>{String(nearestOfficialPointAsset.feature.properties.name)}</strong>
                        {` · ${Math.round(nearestOfficialPointAsset.distance)} m from Point A`}<br />
                        {`${officialAssetClassification(nearestOfficialPointAsset.feature.properties)} · ${(nearestOfficialPointAsset.feature.properties.voltage_kv as number[]).join("/")} kV · ${String(nearestOfficialPointAsset.feature.properties.owner)}`}
                      </p>
                    ) : null}
                    <small>Published network context only. Capacity and connection availability require confirmation from the network operator.</small>
                  </details>
                </div>
              ) : null}
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
                      Three corridor objectives
                    </span>
                    <small>
                      {alternatives.candidate_count} deterministic candidates
                      screened
                    </small>
                  </div>
                  <div className="comparison-cards">
                    {alternatives.alternatives.map((alternative) => {
                      const groupKey = corridorSignature(alternative);
                      return (
                        <button
                          key={alternative.strategy}
                          type="button"
                          className={`comparison-card ${selectedStrategy === alternative.strategy ? "selected" : ""}`}
                          onClick={() => {
                            setSelectedCorridorKey(groupKey);
                            setSelectedStrategy(alternative.strategy);
                          }}
                        >
                          <strong
                            style={{
                              color: routeMeta[alternative.strategy].color,
                            }}
                          >
                            {routeMeta[alternative.strategy].label}
                          </strong>
                          <span>
                            {alternative.route_length_m} m · {alternative.strategy === "environmental"
                              ? `${alternative.environmental_sensitivity_overlap_m2} m² overlap`
                              : alternative.strategy === "constructability"
                                ? `${alternative.turn_count} turns`
                                : "minimum length"}
                          </span>
                          <small>{cardTradeoff(alternative)}</small>
                        </button>
                      );
                    })}
                  </div>
                  {selectedPlan ? (
                    <div className="constraint-card result-card">
                      <details>
                        <summary>Technical details</summary>
                        <dl>
                          <div><dt>Water review crossings</dt><dd>{selectedPlan.water_crossings_requiring_specialist_review}</dd></div>
                          <div><dt>Bridge exposure</dt><dd>{selectedPlan.road_bridge_segments_m} m</dd></div>
                          <div><dt>Tunnel exposure</dt><dd>{selectedPlan.road_tunnel_segments_m} m</dd></div>
                          <div><dt>Major-road exposure</dt><dd>{selectedPlan.major_road_exposure_m} m</dd></div>
                          <div><dt>Candidate rank</dt><dd>{selectedPlan.candidate_rank}</dd></div>
                          <div><dt>Shared-edge overlap</dt><dd>{Object.entries(selectedPlan.pairwise_overlap).map(([strategy, value]) => `${routeMeta[strategy as Strategy]?.label ?? strategy} ${value}%`).join(" · ") || "None"}</dd></div>
                          <div><dt>Candidates screened</dt><dd>{alternatives.candidate_count}</dd></div>
                        </dl>
                      </details>
                    </div>
                  ) : null}
                  <button type="button" className="export-assessment" onClick={exportAssessment}>
                    Export assessment
                  </button>
                  {exportMessage ? <p className="export-message">{exportMessage}</p> : null}
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
            <div ref={mapContainer} className="map" onClick={placeMapPoint} />
            {selectedOfficialAsset ? (
              <aside className="official-asset-popover" aria-label="Official asset details">
                <button type="button" onClick={() => setSelectedOfficialAsset(null)} aria-label="Close official asset details">×</button>
                <strong>{String(selectedOfficialAsset.properties.name ?? "Unnamed published asset")}</strong>
                <span>{officialAssetKindLabel(selectedOfficialAsset.properties.kind)}</span>
                <dl>
                  <div><dt>Owner</dt><dd>{String(selectedOfficialAsset.properties.owner ?? "Not published")}</dd></div>
                  <div><dt>Voltage</dt><dd>{Array.isArray(selectedOfficialAsset.properties.voltage_kv) ? `${(selectedOfficialAsset.properties.voltage_kv as number[]).join("/")} kV` : "Not published"}</dd></div>
                  <div><dt>Status</dt><dd>{officialAssetStatusLabel(selectedOfficialAsset.properties.status)}</dd></div>
                  <div><dt>Cable / overhead</dt><dd>{String(selectedOfficialAsset.properties.installation ?? "Not applicable")}</dd></div>
                  <div><dt>From Point A</dt><dd>{selectedOfficialDistances?.pointA === null ? "—" : `${Math.round(selectedOfficialDistances?.pointA ?? 0)} m`}</dd></div>
                  <div><dt>From Point B</dt><dd>{selectedOfficialDistances?.pointB === null ? "—" : `${Math.round(selectedOfficialDistances?.pointB ?? 0)} m`}</dd></div>
                </dl>
              </aside>
            ) : null}
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
                  ? "Hide analysis"
                  : "Show analysis"}
              </button>
              {(Object.keys(routeMeta) as Strategy[]).map((strategy) => (
                <button
                  key={strategy}
                  type="button"
                  className={`legend-layer ${visibleStrategies[strategy] ? "active" : ""}`}
                  aria-pressed={visibleStrategies[strategy]}
                  onClick={() =>
                    setVisibleStrategies((current) => ({
                      ...current,
                      [strategy]: !current[strategy],
                    }))
                  }
                >
                  <i className={`route-${strategy}`} /> {routeMeta[strategy].label}
                </button>
              ))}
              <span><i className="row" /> Selected corridor</span>
              <span><i className="origin" /> Point A</span>
              <span><i className="destination" /> Point B</span>
              <button
                type="button"
                className={`legend-layer official-context-toggle ${officialContextVisible ? "active" : ""}`}
                aria-pressed={officialContextVisible}
                onClick={() => {
                  setOfficialContextVisible((visible) => !visible);
                  setSelectedOfficialAsset(null);
                }}
              >
                <i className="official-grid" /> Official grid context
              </button>
            </div>
          </div>
        </MapErrorBoundary>
      </section>
    </main>
  );
}
export default App;
