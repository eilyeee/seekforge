import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev proxy targets the local `seekforge serve` instance; the production
// build is served statically by the server itself (same origin).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    // The only chunk over Rollup's default 500 kB warning is the CodeMirror
    // editor (~1 MB), which is deliberately lazy-loaded (see FilesView) so it
    // never lands in the initial bundle. Raise the limit just past it so a real
    // regression in any eagerly-loaded chunk still warns.
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        // Split the rarely-changing React runtime into its own chunk so app
        // edits don't bust its cache. (CodeMirror is already split out via the
        // lazily-imported editor.) Rolldown only accepts the function form.
        manualChunks: (id: string) => (/node_modules\/(react|react-dom|scheduler)\//.test(id) ? "react" : undefined),
      },
    },
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
