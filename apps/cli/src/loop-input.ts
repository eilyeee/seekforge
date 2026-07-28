import { assertLoopDagAcyclic, isRecord, type LoopDagCondition, type LoopDagNode } from "@seekforge/core";
import { resolve } from "node:path";

export type ParsedLoopSpeculation = {
  task: string;
  verifyCommand: string;
  candidates: Array<{ id: string; guidance: string }>;
};

export type ParsedLoopDag = {
  nodes: LoopDagNode[];
  nodeWorkspaces: Map<string, string>;
  fanIn?: { verifyCommand: string; maxIterations?: number };
};

const SPECULATION_CANDIDATE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DAG_ID_RE = SPECULATION_CANDIDATE_ID_RE;

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 512 || value.includes("\0")) return false;
  const normalized = value.replaceAll("\\", "/");
  return (
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:\//.test(normalized) &&
    normalized.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export function parseLoopSpeculationInput(value: unknown): ParsedLoopSpeculation {
  if (
    !isRecord(value) ||
    typeof value.task !== "string" ||
    !value.task.trim() ||
    value.task.length > 64 * 1024 ||
    typeof value.verifyCommand !== "string" ||
    !value.verifyCommand.trim() ||
    value.verifyCommand.length > 8_192 ||
    !Array.isArray(value.candidates) ||
    value.candidates.length < 2 ||
    value.candidates.length > 3
  ) {
    throw new Error("Loop speculation requires task, verifyCommand, and 2 or 3 candidates");
  }
  const ids = new Set<string>();
  const candidates = value.candidates.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      !SPECULATION_CANDIDATE_ID_RE.test(candidate.id) ||
      ids.has(candidate.id) ||
      typeof candidate.guidance !== "string" ||
      !candidate.guidance.trim() ||
      candidate.guidance.length > 8_192
    ) {
      throw new Error("Each Loop speculation candidate requires a unique safe id and bounded guidance");
    }
    ids.add(candidate.id);
    return { id: candidate.id, guidance: candidate.guidance };
  });
  return { task: value.task, verifyCommand: value.verifyCommand, candidates };
}

function parseLoopDagCondition(value: unknown, depth = 0): LoopDagCondition {
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

export function parseLoopDagInput(value: unknown, workspace: string): ParsedLoopDag {
  if (!isRecord(value) || !Array.isArray(value.nodes) || value.nodes.length < 1 || value.nodes.length > 64) {
    throw new Error("Loop DAG must be an object with 1 to 64 nodes");
  }
  let fanIn: ParsedLoopDag["fanIn"];
  if (value.fanIn !== undefined) {
    if (
      !isRecord(value.fanIn) ||
      typeof value.fanIn.verifyCommand !== "string" ||
      !value.fanIn.verifyCommand.trim() ||
      value.fanIn.verifyCommand.length > 8_192
    ) {
      throw new Error("Loop DAG fanIn requires a verifyCommand");
    }
    if (
      value.fanIn.maxIterations !== undefined &&
      (!Number.isSafeInteger(value.fanIn.maxIterations) ||
        (value.fanIn.maxIterations as number) < 1 ||
        (value.fanIn.maxIterations as number) > 5)
    ) {
      throw new Error("Loop DAG fanIn maxIterations must be 1 to 5");
    }
    fanIn = {
      verifyCommand: value.fanIn.verifyCommand,
      ...(typeof value.fanIn.maxIterations === "number" ? { maxIterations: value.fanIn.maxIterations } : {}),
    };
  }
  const nodeWorkspaces = new Map<string, string>();
  const ids = new Set<string>();
  const nodes = value.nodes.map((node): LoopDagNode => {
    if (!isRecord(node)) throw new Error("Loop DAG nodes must be objects");
    if (typeof node.id !== "string" || typeof node.task !== "string" || typeof node.verifyCommand !== "string") {
      throw new Error("Each Loop DAG node requires string id, task, and verifyCommand fields");
    }
    if (
      !DAG_ID_RE.test(node.id) ||
      ids.has(node.id) ||
      !node.task.trim() ||
      node.task.length > 64 * 1024 ||
      !node.verifyCommand.trim() ||
      node.verifyCommand.length > 8_192
    ) {
      throw new Error(`Loop DAG node must have a unique safe id and bounded task/verifier: ${node.id}`);
    }
    ids.add(node.id);
    if (
      node.dependsOn !== undefined &&
      (!Array.isArray(node.dependsOn) || !node.dependsOn.every((id) => typeof id === "string"))
    ) {
      throw new Error(`Loop DAG node ${node.id} dependsOn must be a string array`);
    }
    if (node.workspace !== undefined) {
      if (typeof node.workspace !== "string" || node.workspace.trim() === "") {
        throw new Error(`Loop DAG node ${node.id} workspace must be a non-empty path`);
      }
      nodeWorkspaces.set(node.id, resolve(workspace, node.workspace));
    }
    if (
      node.priority !== undefined &&
      (!Number.isSafeInteger(node.priority) || (node.priority as number) < -10 || (node.priority as number) > 10)
    ) {
      throw new Error(`Loop DAG node ${node.id} priority must be an integer from -10 to 10`);
    }
    if (
      node.maxRetries !== undefined &&
      (!Number.isSafeInteger(node.maxRetries) || (node.maxRetries as number) < 0 || (node.maxRetries as number) > 5)
    ) {
      throw new Error(`Loop DAG node ${node.id} maxRetries must be an integer from 0 to 5`);
    }
    if (
      node.budgetWeight !== undefined &&
      (typeof node.budgetWeight !== "number" || !Number.isFinite(node.budgetWeight) || node.budgetWeight <= 0)
    ) {
      throw new Error(`Loop DAG node ${node.id} budgetWeight must be positive`);
    }
    if (
      node.failurePolicy !== undefined &&
      node.failurePolicy !== "skip_dependents" &&
      node.failurePolicy !== "continue" &&
      node.failurePolicy !== "stop"
    ) {
      throw new Error(`Loop DAG node ${node.id} failurePolicy is invalid`);
    }
    if (
      node.resources !== undefined &&
      (!Array.isArray(node.resources) ||
        node.resources.length === 0 ||
        node.resources.length > 32 ||
        !node.resources.every((item) => typeof item === "string" && DAG_ID_RE.test(item)) ||
        new Set(node.resources).size !== node.resources.length)
    ) {
      throw new Error(`Loop DAG node ${node.id} resources must be unique safe names`);
    }
    if (node.requiresApproval !== undefined && typeof node.requiresApproval !== "boolean") {
      throw new Error(`Loop DAG node ${node.id} requiresApproval must be boolean`);
    }
    if (node.consumeDependencyOutputs !== undefined && typeof node.consumeDependencyOutputs !== "boolean") {
      throw new Error(`Loop DAG node ${node.id} consumeDependencyOutputs must be boolean`);
    }
    if (
      node.outputPaths !== undefined &&
      (!Array.isArray(node.outputPaths) ||
        node.outputPaths.length === 0 ||
        node.outputPaths.length > 64 ||
        !node.outputPaths.every((item) => typeof item === "string" && isSafeRelativePath(item)) ||
        new Set(node.outputPaths).size !== node.outputPaths.length)
    ) {
      throw new Error(`Loop DAG node ${node.id} outputPaths must be unique safe relative paths`);
    }
    return {
      id: node.id,
      task: node.task,
      verifyCommand: node.verifyCommand,
      ...(Array.isArray(node.dependsOn) ? { dependsOn: node.dependsOn as string[] } : {}),
      ...(typeof node.priority === "number" ? { priority: node.priority } : {}),
      ...(typeof node.budgetWeight === "number" ? { budgetWeight: node.budgetWeight } : {}),
      ...(typeof node.maxRetries === "number" ? { maxRetries: node.maxRetries } : {}),
      ...(typeof node.failurePolicy === "string" ? { failurePolicy: node.failurePolicy } : {}),
      ...(Array.isArray(node.resources) ? { resources: node.resources as string[] } : {}),
      ...(node.condition !== undefined ? { condition: parseLoopDagCondition(node.condition) } : {}),
      ...(typeof node.requiresApproval === "boolean" ? { requiresApproval: node.requiresApproval } : {}),
      ...(typeof node.consumeDependencyOutputs === "boolean"
        ? { consumeDependencyOutputs: node.consumeDependencyOutputs }
        : {}),
      ...(Array.isArray(node.outputPaths) ? { outputPaths: node.outputPaths as string[] } : {}),
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const conditionReferences = (condition: LoopDagCondition): string[] => {
    if ("nodeId" in condition) return [condition.nodeId];
    if ("not" in condition) return conditionReferences(condition.not);
    return ("all" in condition ? condition.all : condition.any).flatMap(conditionReferences);
  };
  for (const node of nodes) {
    const dependencies = node.dependsOn ?? [];
    if (
      new Set(dependencies).size !== dependencies.length ||
      dependencies.some((dependency) => dependency === node.id || !byId.has(dependency))
    ) {
      throw new Error(`Loop DAG node ${node.id} has invalid dependencies`);
    }
    if (
      node.condition &&
      conditionReferences(node.condition).some((dependency) => !dependencies.includes(dependency))
    ) {
      throw new Error(`Loop DAG node ${node.id} condition must reference one of its dependencies`);
    }
  }
  assertLoopDagAcyclic(nodes);
  return { nodes, nodeWorkspaces, ...(fanIn ? { fanIn } : {}) };
}
