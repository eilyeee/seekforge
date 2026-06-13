import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // The TUI ships inside the published `seekforge` package as a second
    // bin (seekforge-tui); its workspace sources are bundled like core's.
    tui: "../tui/src/index.tsx",
  },
  format: ["esm"],
  // No sourcemaps in the published bundle — they were ~70% of the tarball
  // and a shipped CLI doesn't need them (dev uses tsx on the sources).
  sourcemap: false,
  clean: true,
  // Workspace packages don't exist on npm — bundle them into the CLI.
  // Their runtime deps (zod, ink, react) are declared as real dependencies.
  noExternal: [/^@seekforge\//],
  external: ["ink", "ink-spinner", "react"],
  // Copy the built desktop web UI into dist/web so the published package's
  // `seekforge serve` ships a usable web workbench (not just the API).
  onSuccess: "node scripts/bundle-web.mjs",
});
