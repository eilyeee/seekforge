import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readFileIfExists } from "../util/fs.js";
import { isRecord } from "../util/guards.js";
import type { LoopVerificationStage } from "./auto-loop.js";

export type DiscoveredLoopVerificationPlan = {
  stages: LoopVerificationStage[];
  sources: string[];
};

const PACKAGE_JSON_LIMIT = 1024 * 1024;

function hasRegularRootFile(workspace: string, name: string): boolean {
  try {
    const stat = lstatSync(join(workspace, name));
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function packageManager(workspace: string): "pnpm" | "yarn" | "bun" | "npm" {
  if (hasRegularRootFile(workspace, "pnpm-lock.yaml")) return "pnpm";
  if (hasRegularRootFile(workspace, "yarn.lock")) return "yarn";
  if (hasRegularRootFile(workspace, "bun.lock") || hasRegularRootFile(workspace, "bun.lockb")) return "bun";
  return "npm";
}

function scriptCommand(manager: "pnpm" | "yarn" | "bun" | "npm", script: string): string {
  if (manager === "pnpm") return script === "test" ? "pnpm test" : `pnpm run ${script}`;
  if (manager === "yarn") return `yarn ${script}`;
  if (manager === "bun") return `bun run ${script}`;
  return script === "test" ? "npm test" : `npm run ${script}`;
}

function packageStages(workspace: string): DiscoveredLoopVerificationPlan | undefined {
  const target = join(workspace, "package.json");
  const raw = readFileIfExists(target, PACKAGE_JSON_LIMIT);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) return undefined;
  const manager = packageManager(workspace);
  const stages: LoopVerificationStage[] = [];
  for (const script of ["typecheck", "lint", "test", "build"] as const) {
    if (typeof parsed.scripts[script] !== "string" || parsed.scripts[script].trim() === "") continue;
    stages.push({ id: script, command: scriptCommand(manager, script) });
  }
  return stages.length > 0 ? { stages, sources: ["package.json"] } : undefined;
}

/**
 * Builds a conservative verification pipeline from well-known root manifests.
 * It never executes manifest-provided command text: only recognized script names
 * and fixed ecosystem commands are selected.
 */
export function discoverLoopVerificationPlan(workspace: string): DiscoveredLoopVerificationPlan {
  const root = realpathSync.native(workspace);
  const stages: LoopVerificationStage[] = [];
  const sources: string[] = [];
  const packagePlan = packageStages(root);
  if (packagePlan) {
    stages.push(...packagePlan.stages);
    sources.push(...packagePlan.sources);
  }
  if (hasRegularRootFile(root, "Cargo.toml")) {
    stages.push({ id: "cargo-fmt", command: "cargo fmt --check" });
    stages.push({ id: "cargo-test", command: "cargo test --workspace" });
    sources.push("Cargo.toml");
  }
  if (hasRegularRootFile(root, "go.mod")) {
    stages.push({ id: "go-test", command: "go test ./..." });
    sources.push("go.mod");
  }
  if (
    hasRegularRootFile(root, "pyproject.toml") ||
    hasRegularRootFile(root, "pytest.ini") ||
    hasRegularRootFile(root, "setup.cfg")
  ) {
    stages.push({ id: "pytest", command: "python -m pytest" });
    sources.push(
      hasRegularRootFile(root, "pyproject.toml")
        ? "pyproject.toml"
        : hasRegularRootFile(root, "pytest.ini")
          ? "pytest.ini"
          : "setup.cfg",
    );
  }
  if (stages.length === 0) {
    throw new Error("Could not discover a Loop verification plan from root project manifests");
  }
  return { stages, sources };
}
