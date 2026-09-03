import { useCallback, useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";

type Bounds = { west: number; south: number; east: number; north: number };
type Scenario = {
  metadata: {
    scenario_name: string;
    selected_location: string;
    bounds: Bounds;
    source: string;
    retrieved_at: string;
    layer_counts: Record<string, number>;
    statutory_protected_present: boolean;
    limitations: string[];
    disclaimer: string;
  };
  layers: GeoJSON.FeatureCollection;
};
type Plan = {
  strategy: string;
  feasible: boolean;
  centreline: GeoJSON.Geometry;
  right_of_way: GeoJSON.Geometry;
  hard_exclusion_envelope: GeoJSON.Geometry;
  route_length_m: number;
  detour_ratio: number;
  minimum_building_clearance_m: number;
  environmental_sensitivity_overlap_m2: number;
  water_crossing_count: number;
  validation_checks: { passed: boolean }[];
  calculation_trace: string[];
  converged_with?: string[];
};

const apiBaseUrl = "http://localhost:8000";
const layerLabels: Record<string, string> = {
  buildings: "Buildings",
  statutory_protected: "Statutory protected",
  environmental_sensitivity: "Environmental sensitivity",
  water: "Water",
  power_assets: "Power assets",
};
const layerStyles: Record<string, string> = {
  buildings: "buildings-fill",
  statutory_protected: "protected-fill",
  environmental_sensitivity: "environment-fill",
  water: "water-fill",
  power_assets: "power-line",
};

function hasValidWgs84Coordinates(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (typeof value[0] === "number") {
    const [longitude, latitude] = value;
    return typeof latitude === "number" && Number.isFinite(longitude) && Number.isFinite(latitude) && Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90;
  }
  return value.every(hasValidWgs84Coordinates);
}

function boundsFromCoordinates(value: unknown): [[number, number], [number, number]] | null {
  if (!hasValidWgs84Coordinates(value)) return null;
  const positions: [number, number][] = [];
  const collect = (candidate: unknown): void => {
    if (!Array.isArray(candidate)) return;
    if (typeof candidate[0] === "number" && typeof candidate[1] === "number") {
      positions.push([candidate[0], candidate[1]]);
      return;
    }
    candidate.forEach(collect);
  };
  collect(value);
  if (!positions.length) return null;
  const longitudes = positions.map(([longitude]) => longitude);
  const latitudes = positions.map(([, latitude]) => latitude);
  return [[Math.min(...longitudes), Math.min(...latitudes)], [Math.max(...longitudes), Math.max(...latitudes)]];
}

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [alternatives, setAlternatives] = useState<Plan[]>([]);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [clearance, setClearance] = useState(25);
  const [rightOfWayWidth, setRightOfWayWidth] = useState(40);
  const [visibleLayers, setVisibleLayers] = useState<Record<string, boolean>>({
    buildings: true,
    statutory_protected: true,
    environmental_sensitivity: true,
    water: true,
    power_assets: true,
  });

  const fitMap = useCallback((bounds: [[number, number], [number, number]], maxZoom: number) => {
    const instance = map.current;
    if (!instance) return;
    instance.resize();
    requestAnimationFrame(() => instance.fitBounds(bounds, { padding: 70, maxZoom, duration: 350 }));
  }, []);

  const focusScenario = useCallback(() => {
    if (!scenario) return;
    const { west, south, east, north } = scenario.metadata.bounds;
    fitMap([[west, south], [east, north]], 15.3);
  }, [scenario, fitMap]);

  const focusPlan = useCallback((selectedPlan: Plan | null = plan) => {
    if (!scenario || !selectedPlan || !("coordinates" in selectedPlan.centreline)) return;
    const routeBounds = boundsFromCoordinates(selectedPlan.centreline.coordinates);
    if (!routeBounds) return;
    const endpointCoordinates = scenario.layers.features
      .filter((feature) => feature.properties?.layer === "endpoints")
      .map((feature) => (feature.geometry?.type === "Point" ? feature.geometry.coordinates : null))
      .filter((coordinates): coordinates is [number, number] => Array.isArray(coordinates));
    const endpointBounds = boundsFromCoordinates(endpointCoordinates);
    if (!endpointBounds) return;
    fitMap([
      [Math.min(routeBounds[0][0], endpointBounds[0][0]), Math.min(routeBounds[0][1], endpointBounds[0][1])],
      [Math.max(routeBounds[1][0], endpointBounds[1][0]), Math.max(routeBounds[1][1], endpointBounds[1][1])],
    ], 16.2);
  }, [scenario, plan, fitMap]);

  useEffect(() => {
    if (!mapContainer.current || map.current) return;
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
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiBaseUrl}/api/scenario`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.detail?.message ?? `Scenario request failed (${response.status})`);
        }
        return response.json() as Promise<Scenario>;
      })
      .then(setScenario)
      .catch((requestError: Error) => {
        if (requestError.name !== "AbortError") setError(requestError.message);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!mapReady || !map.current || !scenario) return;
    const instance = map.current;
    const sourceId = "gridpath-scenario";
    if (instance.getSource(sourceId)) instance.removeSource(sourceId);
    instance.addSource(sourceId, { type: "geojson", data: scenario.layers });
    const layer = (id: string, type: "fill" | "line" | "circle", filter: unknown[], paint: Record<string, unknown>) => {
      instance.addLayer({ id, type, source: sourceId, filter, paint } as maplibregl.LayerSpecification);
    };
    layer("buildings-fill", "fill", ["==", ["get", "layer"], "buildings"], { "fill-color": "#b85a5a", "fill-opacity": 0.52, "fill-outline-color": "#df8585" });
    layer("protected-fill", "fill", ["==", ["get", "layer"], "statutory_protected"], { "fill-color": "#ec3ba6", "fill-opacity": 0.62, "fill-outline-color": "#ff91ce" });
    layer("environment-fill", "fill", ["==", ["get", "layer"], "environmental_sensitivity"], { "fill-color": "#4eaa67", "fill-opacity": 0.45, "fill-outline-color": "#75d58e" });
    layer("water-fill", "fill", ["==", ["get", "layer"], "water"], { "fill-color": "#3b9fe2", "fill-opacity": 0.67, "fill-outline-color": "#81c8ff" });
    layer("water-line", "line", ["all", ["==", ["get", "layer"], "water"], ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString"]]]], { "line-color": "#55b7f5", "line-width": 2.5 });
    layer("power-line", "line", ["==", ["get", "layer"], "power_assets"], { "line-color": "#f6c453", "line-width": 3 });
    layer("scenario-study-area-outline", "line", ["==", ["get", "layer"], "study_area"], { "line-color": "#ffffff", "line-width": 2, "line-opacity": 0.9 });
    layer("grid-connection", "circle", ["all", ["==", ["get", "layer"], "endpoints"], ["==", ["get", "endpoint_id"], "grid_connection"]], { "circle-radius": 8, "circle-color": "#f6c453", "circle-stroke-width": 2, "circle-stroke-color": "#261e0b" });
    layer("proposed-development", "circle", ["all", ["==", ["get", "layer"], "endpoints"], ["==", ["get", "endpoint_id"], "proposed_development"]], { "circle-radius": 8, "circle-color": "#25f4d0", "circle-stroke-width": 2, "circle-stroke-color": "#071014" });
    focusScenario();
  }, [mapReady, scenario, focusScenario]);

  useEffect(() => {
    if (!map.current || !scenario) return;
    for (const [layerName, visible] of Object.entries(visibleLayers)) {
      const styleId = layerStyles[layerName];
      if (map.current.getLayer(styleId)) map.current.setLayoutProperty(styleId, "visibility", visible ? "visible" : "none");
      if (layerName === "water" && map.current.getLayer("water-line")) map.current.setLayoutProperty("water-line", "visibility", visible ? "visible" : "none");
    }
  }, [scenario, visibleLayers]);

  useEffect(() => {
    if (!mapReady || !map.current || !scenario || !plan || !("coordinates" in plan.centreline) || !hasValidWgs84Coordinates(plan.centreline.coordinates)) return;
    const instance = map.current;
    const removeLayerAndSource = (layerIds: string[], sourceId: string) => {
      layerIds.forEach((layerId) => { if (instance.getLayer(layerId)) instance.removeLayer(layerId); });
      if (instance.getSource(sourceId)) instance.removeSource(sourceId);
    };
    removeLayerAndSource(["hard-exclusions-fill"], "gridpath-hard-exclusions");
    removeLayerAndSource(["route-row-fill", "route-row-outline"], "gridpath-right-of-way");
    removeLayerAndSource(["route-underlay", "route-centreline"], "gridpath-selected-centreline");
    removeLayerAndSource(["route-endpoints", "route-endpoint-labels"], "gridpath-endpoints");
    removeLayerAndSource(["study-area-outline"], "gridpath-study-area");
    const asFeatureCollection = (geometry: GeoJSON.Geometry): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry }] });
    const studyArea = scenario.layers.features.find((feature) => feature.properties?.layer === "study_area");
    const endpoints = scenario.layers.features.filter((feature) => feature.properties?.layer === "endpoints");
    instance.addSource("gridpath-hard-exclusions", { type: "geojson", data: asFeatureCollection(plan.hard_exclusion_envelope) });
    instance.addSource("gridpath-right-of-way", { type: "geojson", data: asFeatureCollection(plan.right_of_way) });
    instance.addSource("gridpath-selected-centreline", { type: "geojson", data: asFeatureCollection(plan.centreline) });
    instance.addSource("gridpath-endpoints", { type: "geojson", data: { type: "FeatureCollection", features: endpoints } });
    if (studyArea) instance.addSource("gridpath-study-area", { type: "geojson", data: { type: "FeatureCollection", features: [studyArea] } });
    instance.addLayer({ id: "hard-exclusions-fill", type: "fill", source: "gridpath-hard-exclusions", paint: { "fill-color": "#f4d35e", "fill-opacity": 0.2 } });
    instance.addLayer({ id: "route-row-fill", type: "fill", source: "gridpath-right-of-way", paint: { "fill-color": "#25f4d0", "fill-opacity": 0.2 } });
    instance.addLayer({ id: "route-row-outline", type: "line", source: "gridpath-right-of-way", paint: { "line-color": "#dffff8", "line-width": 2.5, "line-opacity": 0.95 } } as maplibregl.LineLayerSpecification);
    instance.addLayer({ id: "route-underlay", type: "line", source: "gridpath-selected-centreline", paint: { "line-color": "#03080a", "line-width": 9, "line-opacity": 0.95 } } as maplibregl.LineLayerSpecification);
    instance.addLayer({ id: "route-centreline", type: "line", source: "gridpath-selected-centreline", paint: { "line-color": "#25f4d0", "line-width": 5, "line-opacity": 1 } } as maplibregl.LineLayerSpecification);
    instance.addLayer({ id: "route-endpoints", type: "circle", source: "gridpath-endpoints", paint: { "circle-radius": 10, "circle-color": ["match", ["get", "endpoint_id"], "grid_connection", "#25f4d0", "#ff3ca6"], "circle-stroke-color": "#071014", "circle-stroke-width": 3 } });
    instance.addLayer({ id: "route-endpoint-labels", type: "symbol", source: "gridpath-endpoints", layout: { "text-field": ["get", "label"], "text-size": 13, "text-offset": [0, 1.4], "text-anchor": "top", "text-allow-overlap": true }, paint: { "text-color": "#ffffff", "text-halo-color": "#071014", "text-halo-width": 2 } } as maplibregl.SymbolLayerSpecification);
    if (studyArea) instance.addLayer({ id: "study-area-outline", type: "line", source: "gridpath-study-area", paint: { "line-color": "#ffffff", "line-width": 2.5, "line-opacity": 0.95 } } as maplibregl.LineLayerSpecification);
    focusPlan(plan);
  }, [mapReady, plan, scenario, focusPlan]);

  const toggleLayer = (layerName: string) => setVisibleLayers((current) => ({ ...current, [layerName]: !current[layerName] }));
  const generatePlan = async () => {
    if (!scenario || planning) return;
    setPlanning(true); setPlanError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/api/plan/alternatives`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenario_id: "zurich-dietikon-urdorf-v1", building_clearance_m: clearance, right_of_way_width_m: rightOfWayWidth, strategy: "balanced" }) });
      const body = await response.json();
      if (!response.ok) {
        const detail = body?.detail?.message ?? body?.detail ?? "Planning request failed";
        throw new Error(`HTTP ${response.status}: ${detail}`);
      }
      if (!Array.isArray(body.alternatives) || body.alternatives.length !== 3) {
        throw new Error("HTTP 200: comparison response did not contain three alternatives");
      }
      const calculated = body.alternatives as Plan[];
      setAlternatives(calculated);
      setPlan(calculated.find((alternative) => alternative.strategy === "balanced") ?? calculated[0]);
    } catch (requestError) { setPlanError(requestError instanceof Error ? requestError.message : "Planning request failed"); }
    finally { setPlanning(false); }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div><span className="eyebrow">ZURICH REGION · PLANNING PROTOTYPE</span><h1>GridPath</h1></div>
        <span className="status"><i /> {scenario ? "Scenario loaded" : error ? "Scenario unavailable" : "Loading scenario"}</span>
      </header>
      <section className="workspace">
        <aside className="agent-panel">
          <div className="agent-heading"><span className="agent-mark">GP</span><div><h2>Power-Line Screening</h2><p>Prepared spatial context · no route generated</p></div></div>
          {error ? <div className="message error-message"><strong>Scenario unavailable</strong><br />{error}</div> : !scenario ? <div className="message">Loading prepared Zurich-region spatial layers…</div> : <>
            <div className="message"><strong>{scenario.metadata.scenario_name}</strong><br />{scenario.metadata.selected_location}</div>
            <div className="constraint-card"><span>Prepared layers</span><dl>{Object.entries(layerLabels).map(([name, label]) => <div key={name}><dt><label><input type="checkbox" checked={visibleLayers[name]} onChange={() => toggleLayer(name)} disabled={scenario.metadata.layer_counts[name] === 0} /> {label}</label></dt><dd>{scenario.metadata.layer_counts[name]}</dd></div>)}</dl></div>
            <div className="constraint-card"><span>Endpoints</span><dl><div><dt>Grid connection</dt><dd>Synthetic</dd></div><div><dt>Proposed development</dt><dd>Synthetic</dd></div></dl></div>
            <div className="constraint-card"><span>Engineering assumptions</span><label>Building clearance <input type="number" min="10" max="60" value={clearance} onChange={(event) => setClearance(Number(event.target.value))} /> m</label><label>Right-of-way width <input type="number" min="20" max="80" value={rightOfWayWidth} onChange={(event) => setRightOfWayWidth(Number(event.target.value))} /> m</label></div>
            <button type="button" onClick={generatePlan} disabled={planning}>{planning ? "Calculating alternatives…" : "Generate three alternatives"}<span>5 m grid</span></button>
            {planError ? <div className="message error-message">{planError}</div> : null}
            {alternatives.length ? <div className="comparison-cards">{alternatives.map((alternative) => <button className={`comparison-card ${plan?.strategy === alternative.strategy ? "selected" : ""}`} key={alternative.strategy} type="button" onClick={() => { setPlan(alternative); focusPlan(alternative); }}><strong>{alternative.strategy === "shortest" ? "Shortest feasible" : alternative.strategy === "environmental" ? "Environmental priority" : "Balanced"}</strong><span>{alternative.route_length_m} m · {alternative.environmental_sensitivity_overlap_m2} m² environmental</span><span>{alternative.converged_with?.length ? `Converges with ${alternative.converged_with.join(", ")}` : "Distinct alignment"}</span></button>)}</div> : null}
            {plan ? <div className="constraint-card result-card"><span>{plan.feasible ? "Validated alignment" : "Invalid alignment"}</span><dl><div><dt>Length</dt><dd>{plan.route_length_m} m</dd></div><div><dt>Detour ratio</dt><dd>{plan.detour_ratio}</dd></div><div><dt>Clearance</dt><dd>{plan.minimum_building_clearance_m} m</dd></div><div><dt>Environmental overlap</dt><dd>{plan.environmental_sensitivity_overlap_m2} m²</dd></div><div><dt>Water crossings</dt><dd>{plan.water_crossing_count}</dd></div></dl><details><summary>Calculation trace</summary><ol>{plan.calculation_trace.map((step) => <li key={step}>{step}</li>)}</ol></details></div> : null}
            <p className="source-note">{scenario.metadata.source}<br />Retrieved {scenario.metadata.retrieved_at}</p>
            <p className="disclaimer">{scenario.metadata.disclaimer}</p>
          </>}
        </aside>
        <div className="map-stage"><div ref={mapContainer} className="map" /><button className="focus-route" type="button" onClick={() => plan ? focusPlan() : focusScenario()}>{plan ? "Focus route" : "Focus study area"}</button><div className="legend"><strong>Scenario layers</strong><span><i className="origin" /> Grid connection</span><span><i className="destination" /> Proposed development</span><span><i className="building" /> Buildings</span><span><i className="environment" /> Environmental sensitivity</span><span><i className="water" /> Water</span>{scenario?.metadata.statutory_protected_present ? <span><i className="protected" /> Statutory protected</span> : null}</div></div>
      </section>
    </main>
  );
}

export default App;
