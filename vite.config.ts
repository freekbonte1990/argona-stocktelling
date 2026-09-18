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
      },
    }),
  ],
  test: {
    environment: "node",
    globals: true,
  },
});
