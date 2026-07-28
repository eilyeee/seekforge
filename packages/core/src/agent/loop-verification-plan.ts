import { realpathSync } from "node:fs";
import type { LoopVerificationStage } from "./auto-loop.js";
import {
  ecosystemWorkspaceStages,
  hasRegularRootFile,
  packageManager,
  packageStages,
  workspacePackageStages,
  type DiscoveredLoopVerificationPlan,
} from "./loop-verification-detectors.js";

export type { DiscoveredLoopVerificationPlan } from "./loop-verification-detectors.js";

const MAX_VERIFICATION_STAGES = 16;
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
