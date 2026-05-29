// Copies the built desktop web UI into the CLI bundle (dist/web) so the
// published `seekforge` package ships a UI for `seekforge serve`. Runs after
// tsup (see tsup.config.ts onSuccess). No-op with a warning if the desktop
// app has not been built yet — `prepublishOnly` builds it first.
import { existsSync, rmSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const src = fileURLToPath(new URL("../../desktop/dist", import.meta.url));
const dest = fileURLToPath(new URL("../dist/web", import.meta.url));

if (!existsSync(`${src}/index.html`)) {
  console.warn(
    `[bundle-web] apps/desktop/dist not found — skipping web UI copy.\n` +
      `             run \`pnpm --filter @seekforge/desktop build\` first (prepublishOnly does).`,
  );
  process.exit(0);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`[bundle-web] copied desktop UI → apps/cli/dist/web`);
void here;
