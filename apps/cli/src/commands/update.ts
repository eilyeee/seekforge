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
import { checkForUpdate } from "../version-check.js";

export async function updateCommand(): Promise<void> {
  const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };
  const latest = await checkForUpdate(version);
  if (!latest) {
    console.log(`seekforge ${version} is up to date.`);
    return;
  }
  console.log(`${green(`↑ seekforge ${latest} is available`)} (you have ${version}).`);
  console.log("");
  console.log("Update with:");
  console.log("  npm i -g seekforge");
  console.log("");
  console.log(dim("(Run the install with the package manager you used to install seekforge —"));
  console.log(dim(" e.g. pnpm add -g seekforge. SeekForge never self-updates the global binary.)"));
}
