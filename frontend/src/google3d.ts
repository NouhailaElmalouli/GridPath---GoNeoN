type GoogleMaps = {
  maps: {
    importLibrary: (
      name: string,
    ) => Promise<
      Record<string, new (options: Record<string, unknown>) => HTMLElement>
    >;
  };
};

declare global {
  interface Window {
    google?: GoogleMaps;
  }
}

let loader: Promise<GoogleMaps> | null = null;

export function loadGoogleMaps3D(key: string): Promise<GoogleMaps> {
  if (window.google?.maps?.importLibrary) return Promise.resolve(window.google);
  if (loader) return loader;
  loader = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      "script[data-gridpath-google-maps]",
    );
    if (existing) {
      existing.addEventListener("load", () =>
        window.google
          ? resolve(window.google)
          : reject(new Error("Google Maps failed to load")),
      );
      existing.addEventListener("error", () =>
        reject(new Error("Google Maps failed to load")),
      );
      return;
    }
    const script = document.createElement("script");
    script.dataset.gridpathGoogleMaps = "true";
    script.async = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=beta&libraries=maps3d`;
    script.onload = () =>
      window.google
        ? resolve(window.google)
        : reject(new Error("Google Maps failed to load"));
    script.onerror = () => reject(new Error("Google Maps failed to load"));
    document.head.append(script);
  });
  return loader;
}
