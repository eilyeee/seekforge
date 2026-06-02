// `seekforge update` / `upgrade` — check npm for a newer release and PRINT the
// install command. We deliberately do NOT self-mutate the global install:
//   - the global package may be owned by root / a version manager (npm, pnpm,
//     volta, asdf, brew) — we cannot know which, and running the wrong one can
//     corrupt the install;
//   - spawning `npm i -g` mid-process can replace the very binary we're running.
// Like most CLIs (gh, deno, etc.), we surface the exact command for the user
// to run. This reuses checkForUpdate() from version-check.ts.

import { createRequire } from "node:module";
import { dim, green } from "../colors.js";
import { t } from "../i18n.js";
import { checkForUpdate } from "../version-check.js";

export async function updateCommand(): Promise<void> {
  let version = "0.0.0";
  try {
    version = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;
  } catch {
    // No package.json on the virtual FS in a bun --compile binary; keep fallback.
  }
  const latest = await checkForUpdate(version);
  if (!latest) {
    console.log(t("status.upToDate", { version }));
    return;
  }
  console.log(`${green(t("status.updateAvailable", { latest }))} ${t("status.currentVersion", { version })}`);
  console.log("");
  console.log(t("status.updateWith"));
  console.log(`  ${t("status.npmInstallCmd")}`);
  console.log("");
  console.log(dim(t("status.updateNote")));
  console.log(dim(t("status.updateNote2")));
}
