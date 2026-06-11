import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.tsx"],
  format: ["esm"],
  sourcemap: true,
  clean: true,
  // Workspace packages don't exist on npm — bundle them into the binary.
  // Their runtime deps (zod) are declared as real dependencies below.
  noExternal: [/^@seekforge\//],
  // Ink/React are real npm deps shipped alongside; keep them external.
  external: ["ink", "ink-spinner", "ink-text-input", "react"],
});
