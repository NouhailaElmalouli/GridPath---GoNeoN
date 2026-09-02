import { useEffect, useRef, useState } from "react";
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

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visibleLayers, setVisibleLayers] = useState<Record<string, boolean>>({
    buildings: true,
    statutory_protected: true,
    environmental_sensitivity: true,
    water: true,
    power_assets: true,
  });

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
    layer("grid-connection", "circle", ["all", ["==", ["get", "layer"], "endpoints"], ["==", ["get", "endpoint_id"], "grid_connection"]], { "circle-radius": 8, "circle-color": "#f6c453", "circle-stroke-width": 2, "circle-stroke-color": "#261e0b" });
    layer("proposed-development", "circle", ["all", ["==", ["get", "layer"], "endpoints"], ["==", ["get", "endpoint_id"], "proposed_development"]], { "circle-radius": 8, "circle-color": "#25f4d0", "circle-stroke-width": 2, "circle-stroke-color": "#071014" });
    const { west, south, east, north } = scenario.metadata.bounds;
    instance.fitBounds([[west, south], [east, north]], { padding: 50, duration: 0 });
  }, [mapReady, scenario]);

  useEffect(() => {
    if (!map.current || !scenario) return;
    for (const [layerName, visible] of Object.entries(visibleLayers)) {
      const styleId = layerStyles[layerName];
      if (map.current.getLayer(styleId)) map.current.setLayoutProperty(styleId, "visibility", visible ? "visible" : "none");
      if (layerName === "water" && map.current.getLayer("water-line")) map.current.setLayoutProperty("water-line", "visibility", visible ? "visible" : "none");
    }
  }, [scenario, visibleLayers]);

  const toggleLayer = (layerName: string) => setVisibleLayers((current) => ({ ...current, [layerName]: !current[layerName] }));

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
            <p className="source-note">{scenario.metadata.source}<br />Retrieved {scenario.metadata.retrieved_at}</p>
            <p className="disclaimer">{scenario.metadata.disclaimer}</p>
          </>}
        </aside>
        <div className="map-stage"><div ref={mapContainer} className="map" /><div className="legend"><strong>Scenario layers</strong><span><i className="origin" /> Grid connection</span><span><i className="destination" /> Proposed development</span><span><i className="building" /> Buildings</span><span><i className="environment" /> Environmental sensitivity</span><span><i className="water" /> Water</span>{scenario?.metadata.statutory_protected_present ? <span><i className="protected" /> Statutory protected</span> : null}</div></div>
      </section>
    </main>
  );
}

export default App;
