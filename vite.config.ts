/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Argona Stocktelling",
        short_name: "Stocktelling",
        description: "Tablet-first stocktelling voor Argona-magazijnen.",
        theme_color: "#145c34",
        background_color: "#f4f6f8",
        display: "standalone",
        orientation: "any",
        start_url: "/",
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Alles precachen zodat de app na de eerste load ook zonder netwerk
        // (bv. dieper in een magazijn) blijft werken.
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
        // De serverless API (o.a. de beveiligde centrale historiek) mag NOOIT
        // door de SPA-navigatiefallback naar index.html omgeleid worden, en
        // wordt ook nooit gecachet/geprecachet: de data zit na één geslaagde
        // sync gewoon in IndexedDB (offline-gedrag), niet in de service worker.
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  test: {
    environment: "node",
    globals: true,
    // Registreert enkel extra expect-matchers (bv. toBeInTheDocument) — dit
    // roept geen DOM aan bij het importeren, dus blijft veilig voor de
    // overige tests die in de "node"-omgeving draaien.
    setupFiles: ["./src/test-setup.ts"],
  },
});
