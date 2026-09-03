import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // MapLibre resolves its GeoJSON worker relative to its own ESM module.  Let
  // Vite serve that module directly rather than rewriting the worker URL in
  // the dependency-optimizer cache.
  optimizeDeps: {
    exclude: ["maplibre-gl"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
});
