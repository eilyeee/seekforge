import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev proxy targets the local `seekforge serve` instance; the production
// build is served statically by the server itself (same origin).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:7373",
      "/ws": {
        target: "ws://127.0.0.1:7373",
        ws: true,
      },
    },
  },
});
