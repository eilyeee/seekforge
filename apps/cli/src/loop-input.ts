import {
  assertValidLoopDagNodes,
  isRecord,
  isValidLoopDagId,
  parseGraphLoopOptions,
  parseLoopDagCondition,
  type LoopDagNode,
} from "@seekforge/core";
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
      !isValidLoopDagId(candidate.id) ||
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
  const nodes = value.nodes.map((node): LoopDagNode => {
    if (!isRecord(node)) throw new Error("Loop DAG nodes must be objects");
    if (typeof node.id !== "string" || typeof node.task !== "string" || typeof node.verifyCommand !== "string") {
      throw new Error("Each Loop DAG node requires string id, task, and verifyCommand fields");
    }
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
    if (node.priority !== undefined && typeof node.priority !== "number")
      throw new Error(`Loop DAG node ${node.id} priority must be numeric`);
    if (node.maxRetries !== undefined && typeof node.maxRetries !== "number")
      throw new Error(`Loop DAG node ${node.id} maxRetries must be numeric`);
    if (node.budgetWeight !== undefined && typeof node.budgetWeight !== "number")
      throw new Error(`Loop DAG node ${node.id} budgetWeight must be numeric`);
    if (node.failurePolicy !== undefined && typeof node.failurePolicy !== "string")
      throw new Error(`Loop DAG node ${node.id} failurePolicy must be a string`);
    if (
      node.resources !== undefined &&
      (!Array.isArray(node.resources) || !node.resources.every((item) => typeof item === "string"))
    )
      throw new Error(`Loop DAG node ${node.id} resources must be a string array`);
    if (node.requiresApproval !== undefined && typeof node.requiresApproval !== "boolean") {
      throw new Error(`Loop DAG node ${node.id} requiresApproval must be boolean`);
    }
    if (node.consumeDependencyOutputs !== undefined && typeof node.consumeDependencyOutputs !== "boolean") {
      throw new Error(`Loop DAG node ${node.id} consumeDependencyOutputs must be boolean`);
    }
    if (
      node.outputPaths !== undefined &&
      (!Array.isArray(node.outputPaths) || !node.outputPaths.every((item) => typeof item === "string"))
    )
      throw new Error(`Loop DAG node ${node.id} outputPaths must be a string array`);
    if (node.verifierId !== undefined && typeof node.verifierId !== "string")
      throw new Error(`Loop DAG node ${node.id} verifierId must be a string`);
    // A node may declare bounded Loop configuration. Only the set a Graph
    // `loop` node can also declare is accepted, so `loop-dag export-graph`
    // carries it through unchanged; anything else is named, never dropped.
    const options =
      node.options === undefined ? undefined : parseGraphLoopOptions(node.options, `Loop DAG node ${node.id} options`);
    return {
      id: node.id,
      task: node.task,
      verifyCommand: node.verifyCommand,
      ...(Array.isArray(node.dependsOn) ? { dependsOn: node.dependsOn as string[] } : {}),
      ...(typeof node.priority === "number" ? { priority: node.priority } : {}),
      ...(typeof node.budgetWeight === "number" ? { budgetWeight: node.budgetWeight } : {}),
      ...(typeof node.maxRetries === "number" ? { maxRetries: node.maxRetries } : {}),
      ...(typeof node.failurePolicy === "string"
        ? { failurePolicy: node.failurePolicy as LoopDagNode["failurePolicy"] }
        : {}),
      ...(Array.isArray(node.resources) ? { resources: node.resources as string[] } : {}),
      ...(node.condition !== undefined ? { condition: parseLoopDagCondition(node.condition) } : {}),
      ...(typeof node.requiresApproval === "boolean" ? { requiresApproval: node.requiresApproval } : {}),
      ...(typeof node.consumeDependencyOutputs === "boolean"
        ? { consumeDependencyOutputs: node.consumeDependencyOutputs }
        : {}),
      ...(Array.isArray(node.outputPaths) ? { outputPaths: node.outputPaths as string[] } : {}),
      ...(typeof node.verifierId === "string" ? { verifierId: node.verifierId } : {}),
      ...(options && Object.keys(options).length > 0 ? { options } : {}),
    };
  });
  assertValidLoopDagNodes(nodes);
  return { nodes, nodeWorkspaces, ...(fanIn ? { fanIn } : {}) };
}
