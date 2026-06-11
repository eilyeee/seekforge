/** Repo-root-relative locations of the eval dataset and reports. */

import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
export const evalsDir = join(repoRoot, "evals");
export const tasksDir = join(evalsDir, "tasks");
export const fixturesDir = join(evalsDir, "fixtures");
export const reportsDir = join(evalsDir, "reports");
