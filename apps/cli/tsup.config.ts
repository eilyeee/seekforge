import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  sourcemap: true,
  clean: true,
  // Workspace packages don't exist on npm — bundle them into the CLI.
  // Their runtime deps (zod) are declared as real dependencies below.
  noExternal: [/^@seekforge\//],
});
