import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // The TUI ships inside the published `seekforge` package as a second
    // bin (seekforge-tui); its workspace sources are bundled like core's.
    tui: "../tui/src/index.tsx",
  },
  format: ["esm"],
  sourcemap: true,
  clean: true,
  // Workspace packages don't exist on npm — bundle them into the CLI.
  // Their runtime deps (zod, ink, react) are declared as real dependencies.
  noExternal: [/^@seekforge\//],
  external: ["ink", "ink-spinner", "react"],
});
