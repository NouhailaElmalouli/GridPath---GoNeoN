import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";

const scenarioPoints: GeoJSON.FeatureCollection<GeoJSON.Point> = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { role: "origin", label: "Utility connection" },
      geometry: { type: "Point", coordinates: [8.5068, 47.3918] },
    },
    {
      type: "Feature",
      properties: { role: "destination", label: "Development site" },
      geometry: { type: "Point", coordinates: [8.5328, 47.3838] },
    },
  ],
};

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);

  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    const mapInstance = new maplibregl.Map({
      container: mapContainer.current,
      center: [8.5198, 47.388],
      zoom: 14,
      pitch: 25,
      bearing: -12,
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
    map.current = mapInstance;

    mapInstance.addControl(new maplibregl.NavigationControl(), "bottom-right");
    mapInstance.on("load", () => {
      mapInstance.addSource("scenario-points", {
        type: "geojson",
        data: scenarioPoints,
      });
      mapInstance.addLayer({
        id: "scenario-points-halo",
        type: "circle",
        source: "scenario-points",
        paint: {
          "circle-radius": 12,
          "circle-color": "#071014",
          "circle-stroke-width": 3,
          "circle-stroke-color": [
            "match",
            ["get", "role"],
            "origin",
            "#25f4d0",
            "#ff3ca6",
          ],
        },
      });
    });

    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">ZÜRICH · PLANNING PROTOTYPE</span>
          <h1>N! Corridor</h1>
        </div>
        <span className="status"><i /> Scenario ready</span>
      </header>

      <section className="workspace">
        <aside className="agent-panel">
          <div className="agent-heading">
            <span className="agent-mark">N!</span>
            <div>
              <h2>Alignment Agent</h2>
              <p>Intent → deterministic spatial tools</p>
            </div>
          </div>

          <div className="message">
            Connect the utility point to the development while maintaining
            25 m from buildings and avoiding protected areas.
          </div>

          <div className="constraint-card">
            <span>Interpreted constraints</span>
            <dl>
              <div><dt>Clearance</dt><dd>25 m</dd></div>
              <div><dt>Hard exclusions</dt><dd>Buildings · Water</dd></div>
              <div><dt>Priority</dt><dd>Balanced</dd></div>
            </dl>
          </div>

          <button type="button" disabled>
            Generate alternatives
            <span>Coming next</span>
          </button>

          <p className="disclaimer">
            Demonstrative planning workflow. Not for statutory or engineering approval.
          </p>
        </aside>

        <div className="map-stage">
          <div ref={mapContainer} className="map" />
          <div className="legend">
            <strong>Scenario layers</strong>
            <span><i className="origin" /> Origin</span>
            <span><i className="destination" /> Destination</span>
            <span><i className="exclusion" /> Exclusion</span>
          </div>
        </div>
      </section>
    </main>
  );
}

export default App;
