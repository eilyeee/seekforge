import { isAbsolute } from "node:path";
import { isRecord } from "../util/guards.js";
import type { LoopDagCondition, LoopDagNode } from "./loop-dag.js";

const LOOP_DAG_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidLoopDagId(value: unknown): value is string {
  return typeof value === "string" && LOOP_DAG_ID_RE.test(value);
}

export function isSafeLoopDagRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.includes("\0") &&
    !isAbsolute(value) &&
    !/^[A-Za-z]:[\\/]/.test(value) &&
    value
      .replaceAll("\\", "/")
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export function parseLoopDagCondition(value: unknown, depth = 0): LoopDagCondition {
  if (depth > 8 || !isRecord(value)) throw new Error("Loop DAG condition is invalid or too deeply nested");
  if (typeof value.nodeId === "string" && (value.status === "passed" || value.status === "failed")) {
    return { nodeId: value.nodeId, status: value.status };
  }
  if (value.not !== undefined) return { not: parseLoopDagCondition(value.not, depth + 1) };
  const key = value.all !== undefined ? "all" : value.any !== undefined ? "any" : undefined;
  if (!key || !Array.isArray(value[key]) || value[key].length === 0 || value[key].length > 32) {
    throw new Error("Loop DAG condition must contain nodeId/status, all, any, or not");
  }
  return { [key]: value[key].map((child) => parseLoopDagCondition(child, depth + 1)) } as LoopDagCondition;
}

export function loopDagConditionReferences(
  condition: LoopDagCondition,
  refs: string[] = [],
  depth = 0,
): string[] | undefined {
  if (depth > 8 || refs.length > 64 || !isRecord(condition)) return undefined;
  if ("nodeId" in condition) {
    if (!isValidLoopDagId(condition.nodeId) || (condition.status !== "passed" && condition.status !== "failed")) {
      return undefined;
    }
    refs.push(condition.nodeId);
    return refs.length <= 64 ? refs : undefined;
  }
  if ("not" in condition) return loopDagConditionReferences(condition.not, refs, depth + 1);
  const group = "all" in condition ? condition.all : "any" in condition ? condition.any : undefined;
  if (!Array.isArray(group) || group.length === 0 || group.length > 32) return undefined;
  for (const child of group) if (!loopDagConditionReferences(child, refs, depth + 1)) return undefined;
  return refs;
}

/** Rejects dependency cycles before leases, checkpoints, or worktrees are created. */
export function assertLoopDagAcyclic(nodes: readonly Pick<LoopDagNode, "id" | "dependsOn">[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error("Loop DAG contains a dependency cycle");
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dependency)) visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
}

/** Validates the complete node contract without acquiring resources or writing state. */
export function assertValidLoopDagNodes(nodes: readonly LoopDagNode[]): void {
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > 64) {
    throw new Error("Loop DAG must contain 1 to 64 nodes");
  }
  const byId = new Map<string, LoopDagNode>();
  for (const node of nodes) {
    const candidate: unknown = node;
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      !isValidLoopDagId(candidate.id) ||
      byId.has(candidate.id)
    ) {
      throw new Error(
        `Loop DAG node must have a unique safe id: ${isRecord(candidate) ? String(candidate.id) : "unknown"}`,
      );
    }
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    if (
      typeof node.task !== "string" ||
      typeof node.verifyCommand !== "string" ||
      !node.task.trim() ||
      !node.verifyCommand.trim()
    ) {
      throw new Error(`Loop DAG node is incomplete: ${node.id}`);
    }
    if (node.task.length > 64 * 1024 || node.verifyCommand.length > 8_192) {
      throw new Error(`Loop DAG node is too large: ${node.id}`);
    }
    if (
      node.priority !== undefined &&
      (!Number.isSafeInteger(node.priority) || node.priority < -10 || node.priority > 10)
    ) {
      throw new Error(`Loop DAG node priority must be -10 to 10: ${node.id}`);
    }
    if (
      node.budgetWeight !== undefined &&
      (typeof node.budgetWeight !== "number" || !Number.isFinite(node.budgetWeight) || node.budgetWeight <= 0)
    ) {
      throw new Error(`Loop DAG node budgetWeight must be positive: ${node.id}`);
    }
    if (
      node.maxRetries !== undefined &&
      (!Number.isSafeInteger(node.maxRetries) || node.maxRetries < 0 || node.maxRetries > 5)
    ) {
      throw new Error(`Loop DAG node maxRetries must be 0 to 5: ${node.id}`);
    }
    if (
      node.failurePolicy !== undefined &&
      node.failurePolicy !== "skip_dependents" &&
      node.failurePolicy !== "continue" &&
      node.failurePolicy !== "stop"
    ) {
      throw new Error(`Loop DAG node failurePolicy is invalid: ${node.id}`);
    }
    if (node.verifierId !== undefined && !isValidLoopDagId(node.verifierId)) {
      throw new Error(`Loop DAG node verifierId must be safe: ${node.id}`);
    }
    const dependencies = node.dependsOn ?? [];
    if (
      !Array.isArray(dependencies) ||
      dependencies.some((dependency) => typeof dependency !== "string") ||
      new Set(dependencies).size !== dependencies.length ||
      dependencies.some((dependency) => dependency === node.id || !byId.has(dependency))
    ) {
      throw new Error(`Loop DAG node ${node.id} has invalid dependencies`);
    }
    const conditionRefs = node.condition ? loopDagConditionReferences(node.condition) : [];
    if (conditionRefs === undefined || conditionRefs.some((dependency) => !dependencies.includes(dependency))) {
      throw new Error(`Loop DAG node condition must reference one of its dependencies: ${node.id}`);
    }
    if (
      node.resources !== undefined &&
      (!Array.isArray(node.resources) ||
        node.resources.length === 0 ||
        node.resources.length > 32 ||
        new Set(node.resources).size !== node.resources.length ||
        node.resources.some((resource: unknown) => !isValidLoopDagId(resource)))
    ) {
      throw new Error(`Loop DAG node resources must be unique safe names: ${node.id}`);
    }
    if (node.requiresApproval !== undefined && typeof node.requiresApproval !== "boolean") {
      throw new Error(`Loop DAG node requiresApproval must be boolean: ${node.id}`);
    }
    if (node.consumeDependencyOutputs !== undefined && typeof node.consumeDependencyOutputs !== "boolean") {
      throw new Error(`Loop DAG node consumeDependencyOutputs must be boolean: ${node.id}`);
    }
    if (
      node.outputPaths !== undefined &&
      (!Array.isArray(node.outputPaths) ||
        node.outputPaths.length === 0 ||
        node.outputPaths.length > 64 ||
        new Set(node.outputPaths).size !== node.outputPaths.length ||
        node.outputPaths.some((path: unknown) => !isSafeLoopDagRelativePath(path)))
    ) {
      throw new Error(`Loop DAG node outputPaths must be unique safe relative paths: ${node.id}`);
    }
  }
  assertLoopDagAcyclic(nodes);
}
