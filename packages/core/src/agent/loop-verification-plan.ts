import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readFileIfExists } from "../util/fs.js";
import { isRecord } from "../util/guards.js";
import type { LoopVerificationStage } from "./auto-loop.js";

export type DiscoveredLoopVerificationPlan = {
  stages: LoopVerificationStage[];
  sources: string[];
};

const PACKAGE_JSON_LIMIT = 1024 * 1024;
const MAX_WORKSPACE_STAGES = 12;
const MAX_VERIFICATION_STAGES = 16;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function boundedStageId(...parts: string[]): string {
  const raw = parts.join("-").replaceAll(".", "-");
  if (raw.length <= 128) return raw;
  const suffix = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return `${raw.slice(0, 115).replace(/-+$/, "")}-${suffix}`;
}

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

function workspaceParents(workspace: string): string[] {
  const parents = new Set(["apps", "packages"]);
  const raw = readFileIfExists(join(workspace, "pnpm-workspace.yaml"), 256 * 1024);
  if (raw) {
    for (const line of raw.split("\n")) {
      const match = /^\s*-\s*["']?([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\/\*["']?\s*$/.exec(line);
      if (match) parents.add(match[1]!);
      if (parents.size >= 12) break;
    }
  }
  return [...parents];
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

function workspacePackageStages(
  workspace: string,
  manager: "pnpm" | "yarn" | "bun" | "npm",
): DiscoveredLoopVerificationPlan | undefined {
  type WorkspacePackage = {
    relativePath: string;
    name?: string;
    hasTest: boolean;
    dependencyNames: string[];
  };
  const packages: WorkspacePackage[] = [];
  const stages: LoopVerificationStage[] = [];
  const sources: string[] = [];
  for (const parent of workspaceParents(workspace)) {
    let names: string[];
    try {
      const stat = lstatSync(join(workspace, parent));
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      names = readdirSync(join(workspace, parent)).sort().slice(0, 128);
    } catch {
      continue;
    }
    for (const name of names) {
      if (stages.length >= MAX_WORKSPACE_STAGES) break;
      if (!SAFE_SEGMENT_RE.test(name)) continue;
      const relativePath = `${parent}/${name}`;
      const directory = join(workspace, relativePath);
      try {
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      const raw = readFileIfExists(join(directory, "package.json"), PACKAGE_JSON_LIMIT);
      if (raw === undefined) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(parsed)) continue;
      const dependencyNames = new Set<string>();
      for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        const values = parsed[field];
        if (!isRecord(values)) continue;
        for (const dependency of Object.keys(values)) dependencyNames.add(dependency);
      }
      packages.push({
        relativePath,
        ...(typeof parsed.name === "string" && parsed.name.trim() ? { name: parsed.name.trim() } : {}),
        hasTest:
          isRecord(parsed.scripts) && typeof parsed.scripts.test === "string" && parsed.scripts.test.trim() !== "",
        dependencyNames: [...dependencyNames].sort(),
      });
    }
  }
  const byName = new Map<string, WorkspacePackage[]>();
  for (const entry of packages) {
    if (!entry.name) continue;
    byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
  }
  const dependencyPathsFor = (entry: WorkspacePackage): string[] => {
    const visited = new Set<string>();
    const visit = (current: WorkspacePackage): void => {
      for (const dependencyName of current.dependencyNames) {
        for (const dependency of byName.get(dependencyName) ?? []) {
          if (dependency.relativePath === entry.relativePath || visited.has(dependency.relativePath)) continue;
          visited.add(dependency.relativePath);
          if (visited.size >= 63) return;
          visit(dependency);
        }
      }
    };
    visit(entry);
    return [...visited].sort();
  };
  for (const entry of packages) {
    if (!entry.hasTest || stages.length >= MAX_WORKSPACE_STAGES) continue;
    const relativePath = entry.relativePath;
    const selector = `./${relativePath}`;
    const command =
      manager === "pnpm"
        ? `pnpm --filter ${selector} test`
        : manager === "npm"
          ? `npm --workspace ${relativePath} test`
          : manager === "bun"
            ? `bun --filter ${selector} test`
            : entry.name
              ? `yarn workspace ${entry.name} test`
              : undefined;
    if (!command) continue;
    const dependencyPaths = dependencyPathsFor(entry);
    stages.push({
      id: boundedStageId("test", ...relativePath.split("/")),
      command,
      paths: [relativePath, ...dependencyPaths],
      ...(dependencyPaths.length > 0 ? { dependencyPaths } : {}),
      cacheable: true,
    });
    sources.push(`${relativePath}/package.json`);
  }
  return stages.length > 0 ? { stages, sources } : undefined;
}

function ecosystemWorkspaceStages(workspace: string): DiscoveredLoopVerificationPlan | undefined {
  const stages: LoopVerificationStage[] = [];
  const sources: string[] = [];
  for (const parent of [...new Set([...workspaceParents(workspace), "crates", "services", "modules"])]) {
    let names: string[];
    try {
      const stat = lstatSync(join(workspace, parent));
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      names = readdirSync(join(workspace, parent)).sort().slice(0, 128);
    } catch {
      continue;
    }
    for (const name of names) {
      if (stages.length >= MAX_WORKSPACE_STAGES || !SAFE_SEGMENT_RE.test(name)) continue;
      const relativePath = `${parent}/${name}`;
      const directory = join(workspace, relativePath);
      try {
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      if (hasRegularRootFile(directory, "Cargo.toml")) {
        stages.push({
          id: boundedStageId("cargo", parent, name),
          command: `cargo test --manifest-path ${relativePath}/Cargo.toml`,
          paths: [relativePath],
          cacheable: true,
        });
        sources.push(`${relativePath}/Cargo.toml`);
        continue;
      }
      if (hasRegularRootFile(directory, "go.mod")) {
        stages.push({
          id: boundedStageId("go", parent, name),
          command: `cd ${relativePath} && go test ./...`,
          paths: [relativePath],
          cacheable: true,
        });
        sources.push(`${relativePath}/go.mod`);
        continue;
      }
      if (
        hasRegularRootFile(directory, "pyproject.toml") ||
        hasRegularRootFile(directory, "pytest.ini") ||
        hasRegularRootFile(directory, "setup.cfg")
      ) {
        stages.push({
          id: boundedStageId("pytest", parent, name),
          command: `python -m pytest ${relativePath}`,
          paths: [relativePath],
          cacheable: true,
        });
        sources.push(
          `${relativePath}/${hasRegularRootFile(directory, "pyproject.toml") ? "pyproject.toml" : hasRegularRootFile(directory, "pytest.ini") ? "pytest.ini" : "setup.cfg"}`,
        );
      }
    }
  }
  return stages.length > 0 ? { stages, sources } : undefined;
}

/**
 * Builds a conservative verification pipeline from well-known root manifests.
 * It never executes manifest-provided command text: only recognized script names
 * and fixed ecosystem commands are selected.
 */
export function discoverLoopVerificationPlan(workspace: string): DiscoveredLoopVerificationPlan {
  const root = realpathSync.native(workspace);
  const authoritativeStages: LoopVerificationStage[] = [];
  const authoritativeSources: string[] = [];
  const packagePlan = packageStages(root);
  if (packagePlan) {
    authoritativeStages.push(...packagePlan.stages);
    authoritativeSources.push(...packagePlan.sources);
  }
  if (hasRegularRootFile(root, "Cargo.toml")) {
    authoritativeStages.push({ id: "cargo-fmt", command: "cargo fmt --check" });
    authoritativeStages.push({ id: "cargo-test", command: "cargo test --workspace" });
    authoritativeSources.push("Cargo.toml");
  }
  if (hasRegularRootFile(root, "go.mod")) {
    authoritativeStages.push({ id: "go-test", command: "go test ./..." });
    authoritativeSources.push("go.mod");
  }
  if (
    hasRegularRootFile(root, "pyproject.toml") ||
    hasRegularRootFile(root, "pytest.ini") ||
    hasRegularRootFile(root, "setup.cfg")
  ) {
    authoritativeStages.push({ id: "pytest", command: "python -m pytest" });
    authoritativeSources.push(
      hasRegularRootFile(root, "pyproject.toml")
        ? "pyproject.toml"
        : hasRegularRootFile(root, "pytest.ini")
          ? "pytest.ini"
          : "setup.cfg",
    );
  }
  const workspacePlan = hasRegularRootFile(root, "package.json")
    ? workspacePackageStages(root, packageManager(root))
    : undefined;
  const ecosystemPlan = ecosystemWorkspaceStages(root);
  const authoritative = authoritativeStages.slice(0, MAX_VERIFICATION_STAGES);
  const workspaceCapacity = Math.max(0, MAX_VERIFICATION_STAGES - authoritative.length);
  const granularStages = [...(workspacePlan?.stages ?? []), ...(ecosystemPlan?.stages ?? [])].slice(
    0,
    workspaceCapacity,
  );
  const granularSources = [...(workspacePlan?.sources ?? []), ...(ecosystemPlan?.sources ?? [])].slice(
    0,
    granularStages.length,
  );
  const stages = [...granularStages, ...authoritative];
  const sources = [...granularSources, ...authoritativeSources];
  if (stages.length === 0) {
    throw new Error("Could not discover a Loop verification plan from root project manifests");
  }
  return { stages, sources };
}
