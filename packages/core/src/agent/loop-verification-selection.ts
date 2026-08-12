import { isAbsolute, relative } from "node:path";
import { normalizeVerificationPath } from "@seekforge/shared";
import type { LoopVerificationDecision, LoopVerificationStage } from "./auto-loop.js";

// Selection and validation must agree on what a prefix means, and the surfaces
// that validate a declared plan (WS, REST) sit below core, so the rule is owned
// by `@seekforge/shared`. This module re-exports core's name for the predicate.
export { isVerificationPathPrefix } from "@seekforge/shared";

export function selectLoopVerificationStage(
  workspace: string,
  stage: LoopVerificationStage,
  changedPaths: ReadonlySet<string>,
): LoopVerificationDecision {
  if (!stage.paths?.length) return { stageId: stage.id, action: "run", reason: "full", matchedPaths: [] };
  const prefixes = stage.paths.map(normalizeVerificationPath).filter((value): value is string => value !== null);
  const dependencyPrefixes = new Set(
    (stage.dependencyPaths ?? []).map(normalizeVerificationPath).filter((value): value is string => value !== null),
  );
  const direct: string[] = [];
  const dependency: string[] = [];
  for (const changedPath of changedPaths) {
    const candidate = normalizeVerificationPath(
      isAbsolute(changedPath) ? relative(workspace, changedPath) : changedPath,
    );
    if (candidate === null) return { stageId: stage.id, action: "run", reason: "full", matchedPaths: [] };
    const matchedPrefix = prefixes
      .filter((prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`))
      .sort((left, right) => right.length - left.length)[0];
    if (matchedPrefix) (dependencyPrefixes.has(matchedPrefix) ? dependency : direct).push(candidate);
  }
  if (direct.length > 0) {
    return { stageId: stage.id, action: "run", reason: "direct", matchedPaths: [...new Set(direct)].slice(0, 16) };
  }
  if (dependency.length > 0) {
    return {
      stageId: stage.id,
      action: "run",
      reason: "dependency",
      matchedPaths: [...new Set(dependency)].slice(0, 16),
    };
  }
  return { stageId: stage.id, action: "skip", reason: "unaffected", matchedPaths: [] };
}
