import { createHash } from "node:crypto";
import { isRecord } from "../util/guards.js";
import { isValidLoopDagId } from "./loop-dag-validation.js";

export const MAX_GRAPH_NODES = 128;
export const MAX_GRAPH_DEPTH = 4;
export const MAX_GRAPH_CONCURRENCY = 8;
export const MAX_GRAPH_DEFINITION_BYTES = 256 * 1024;
export const MAX_GRAPH_NODE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export type GraphNodeKind = "agent" | "loop" | "function" | "router" | "gate" | "subgraph";
export type GraphNodeStatus = "passed" | "failed" | "skipped" | "waiting_approval";
export type GraphRunStatus = "running" | "paused" | "passed" | "failed" | "cancelled";
export type GraphCondition =
  | { nodeId: string; status: GraphNodeStatus }
  | { all: GraphCondition[] }
  | { any: GraphCondition[] }
  | { not: GraphCondition };

export type GraphRoute = { id: string; when?: GraphCondition };
export type GraphNode = {
  id: string;
  kind: GraphNodeKind;
  dependsOn?: string[];
  condition?: GraphCondition;
  route?: { routerId: string; branch: string };
  workspace?: string;
  task?: string;
  verifyCommand?: string;
  mode?: "ask" | "edit";
  approvalMode?: "auto" | "acceptEdits" | "confirm" | "manual";
  handler?: string;
  routes?: GraphRoute[];
  graph?: EngineeringGraphDefinition;
  maxRetries?: number;
  timeoutMs?: number;
};

export type EngineeringGraphDefinition = {
  graphId: string;
  nodes: GraphNode[];
  maxConcurrency?: number;
  failurePolicy?: "stop" | "continue";
  costBudgetUsd?: number;
  tokenBudget?: number;
};

function graphNodeCount(definition: EngineeringGraphDefinition): number {
  return definition.nodes.reduce((total, node) => total + 1 + (node.graph ? graphNodeCount(node.graph) : 0), 0);
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function parseCondition(value: unknown, depth = 0): GraphCondition {
  if (depth > 8 || !isRecord(value)) throw new Error("Graph condition is invalid or too deeply nested");
  const variants =
    Number(value.nodeId !== undefined || value.status !== undefined) +
    Number(value.not !== undefined) +
    Number(value.all !== undefined) +
    Number(value.any !== undefined);
  if (variants !== 1) throw new Error("Graph condition must use exactly one condition form");
  if (
    isValidLoopDagId(value.nodeId) &&
    (value.status === "passed" ||
      value.status === "failed" ||
      value.status === "skipped" ||
      value.status === "waiting_approval")
  ) {
    return { nodeId: value.nodeId, status: value.status };
  }
  if (value.not !== undefined) return { not: parseCondition(value.not, depth + 1) };
  const key = value.all !== undefined ? "all" : value.any !== undefined ? "any" : undefined;
  if (!key || !isDenseArray(value[key]) || value[key].length === 0 || value[key].length > 32) {
    throw new Error("Graph condition must contain nodeId/status, all, any, or not");
  }
  return { [key]: value[key].map((child) => parseCondition(child, depth + 1)) } as GraphCondition;
}

export function graphConditionReferences(condition: GraphCondition, refs: string[] = [], depth = 0): string[] {
  if (depth > 8 || refs.length > MAX_GRAPH_NODES || !isRecord(condition)) throw new Error("Graph condition is invalid");
  if ("nodeId" in condition) {
    if (!isValidLoopDagId(condition.nodeId)) throw new Error("Graph condition node id is invalid");
    refs.push(condition.nodeId);
    if (refs.length > MAX_GRAPH_NODES) throw new Error("Graph condition has too many references");
    return refs;
  }
  if ("not" in condition) return graphConditionReferences(condition.not, refs, depth + 1);
  const group = "all" in condition ? condition.all : "any" in condition ? condition.any : undefined;
  if (!Array.isArray(group) || group.length === 0 || group.length > 32) throw new Error("Graph condition is invalid");
  for (const child of group) graphConditionReferences(child, refs, depth + 1);
  return refs;
}

export function graphConditionMatches(
  condition: GraphCondition,
  results: ReadonlyMap<string, { status: GraphNodeStatus }>,
): boolean {
  if ("nodeId" in condition) return results.get(condition.nodeId)?.status === condition.status;
  if ("not" in condition) return !graphConditionMatches(condition.not, results);
  if ("all" in condition) return condition.all.every((child) => graphConditionMatches(child, results));
  return condition.any.some((child) => graphConditionMatches(child, results));
}

function parseNode(value: unknown, depth: number): GraphNode {
  if (!isRecord(value) || !isValidLoopDagId(value.id)) throw new Error("Every Graph node requires a safe id");
  const kinds: GraphNodeKind[] = ["agent", "loop", "function", "router", "gate", "subgraph"];
  if (typeof value.kind !== "string" || !kinds.includes(value.kind as GraphNodeKind)) {
    throw new Error(`Graph node ${value.id} has an invalid kind`);
  }
  const dependsOn = value.dependsOn ?? [];
  if (!isDenseArray(dependsOn) || !dependsOn.every(isValidLoopDagId)) {
    throw new Error(`Graph node ${value.id} dependsOn must contain safe ids`);
  }
  if (new Set(dependsOn).size !== dependsOn.length)
    throw new Error(`Graph node ${value.id} has duplicate dependencies`);
  if (value.workspace !== undefined && (typeof value.workspace !== "string" || !value.workspace.trim())) {
    throw new Error(`Graph node ${value.id} workspace must be a non-empty path`);
  }
  if (
    value.maxRetries !== undefined &&
    (typeof value.maxRetries !== "number" ||
      !Number.isSafeInteger(value.maxRetries) ||
      value.maxRetries < 0 ||
      value.maxRetries > 5)
  ) {
    throw new Error(`Graph node ${value.id} maxRetries must be 0 to 5`);
  }
  if (
    value.timeoutMs !== undefined &&
    (typeof value.timeoutMs !== "number" ||
      !Number.isSafeInteger(value.timeoutMs) ||
      value.timeoutMs < 1 ||
      value.timeoutMs > MAX_GRAPH_NODE_TIMEOUT_MS)
  ) {
    throw new Error(`Graph node ${value.id} timeoutMs must be 1 to ${MAX_GRAPH_NODE_TIMEOUT_MS}`);
  }
  const kind = value.kind as GraphNodeKind;
  if (kind === "subgraph" && value.maxRetries !== undefined && value.maxRetries !== 0) {
    throw new Error(`Graph subgraph node ${value.id} cannot retry without a durable child checkpoint`);
  }
  if (
    (kind === "agent" || kind === "loop") &&
    (typeof value.task !== "string" || !value.task.trim() || value.task.length > 64 * 1024)
  ) {
    throw new Error(`Graph ${kind} node ${value.id} requires a bounded task`);
  }
  if (
    kind === "loop" &&
    (typeof value.verifyCommand !== "string" || !value.verifyCommand.trim() || value.verifyCommand.length > 8_192)
  ) {
    throw new Error(`Graph loop node ${value.id} requires a bounded verifyCommand`);
  }
  if (kind === "function" && !isValidLoopDagId(value.handler)) {
    throw new Error(`Graph function node ${value.id} requires a safe handler id`);
  }
  let routes: GraphRoute[] | undefined;
  if (kind === "router") {
    if (!isDenseArray(value.routes) || value.routes.length === 0 || value.routes.length > 32) {
      throw new Error(`Graph router node ${value.id} requires 1 to 32 routes`);
    }
    const routeIds = new Set<string>();
    routes = value.routes.map((route) => {
      if (!isRecord(route) || !isValidLoopDagId(route.id) || routeIds.has(route.id)) {
        throw new Error(`Graph router node ${value.id} has invalid or duplicate routes`);
      }
      routeIds.add(route.id);
      return { id: route.id, ...(route.when !== undefined ? { when: parseCondition(route.when) } : {}) };
    });
    if (routes.filter((route) => route.when === undefined).length > 1) {
      throw new Error(`Graph router node ${value.id} may have at most one default route`);
    }
  }
  if (
    value.route !== undefined &&
    (!isRecord(value.route) || !isValidLoopDagId(value.route.routerId) || !isValidLoopDagId(value.route.branch))
  ) {
    throw new Error(`Graph node ${value.id} route binding is invalid`);
  }
  if (value.mode !== undefined && value.mode !== "ask" && value.mode !== "edit")
    throw new Error(`Graph node ${value.id} mode is invalid`);
  if (
    value.approvalMode !== undefined &&
    !["auto", "acceptEdits", "confirm", "manual"].includes(String(value.approvalMode))
  ) {
    throw new Error(`Graph node ${value.id} approvalMode is invalid`);
  }
  return {
    id: value.id,
    kind,
    ...(dependsOn.length ? { dependsOn: [...dependsOn] as string[] } : {}),
    ...(value.condition !== undefined ? { condition: parseCondition(value.condition) } : {}),
    ...(isRecord(value.route)
      ? { route: { routerId: value.route.routerId as string, branch: value.route.branch as string } }
      : {}),
    ...(typeof value.workspace === "string" ? { workspace: value.workspace } : {}),
    ...(typeof value.task === "string" ? { task: value.task } : {}),
    ...(typeof value.verifyCommand === "string" ? { verifyCommand: value.verifyCommand } : {}),
    ...(value.mode === "ask" || value.mode === "edit" ? { mode: value.mode } : {}),
    ...(typeof value.approvalMode === "string"
      ? { approvalMode: value.approvalMode as GraphNode["approvalMode"] }
      : {}),
    ...(typeof value.handler === "string" ? { handler: value.handler } : {}),
    ...(routes ? { routes } : {}),
    ...(kind === "subgraph" ? { graph: parseEngineeringGraphDefinition(value.graph, depth + 1) } : {}),
    ...(typeof value.maxRetries === "number" ? { maxRetries: value.maxRetries } : {}),
    ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}),
  };
}

export function parseEngineeringGraphDefinition(value: unknown, depth = 0): EngineeringGraphDefinition {
  if (depth > MAX_GRAPH_DEPTH) throw new Error(`Graph nesting exceeds ${MAX_GRAPH_DEPTH}`);
  if (!isRecord(value) || !isValidLoopDagId(value.graphId) || !isDenseArray(value.nodes)) {
    throw new Error("Graph definition requires graphId and nodes");
  }
  if (value.nodes.length === 0 || value.nodes.length > MAX_GRAPH_NODES) {
    throw new Error(`Graph must contain 1 to ${MAX_GRAPH_NODES} nodes`);
  }
  const nodes = value.nodes.map((node) => parseNode(node, depth));
  if (depth > 0 && nodes.some((node) => node.kind === "gate")) {
    throw new Error("Nested Graph approval gates require a durable child checkpoint and are not supported");
  }
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) throw new Error(`Duplicate Graph node id: ${node.id}`);
    ids.add(node.id);
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    for (const dependency of node.dependsOn ?? []) {
      if (dependency === node.id || !byId.has(dependency))
        throw new Error(`Graph node ${node.id} has invalid dependency: ${dependency}`);
    }
    for (const reference of node.condition ? graphConditionReferences(node.condition) : []) {
      if (!(node.dependsOn ?? []).includes(reference))
        throw new Error(`Graph node ${node.id} condition must reference a dependency`);
    }
    if (node.route) {
      const router = byId.get(node.route.routerId);
      if (
        router?.kind !== "router" ||
        !(node.dependsOn ?? []).includes(router.id) ||
        !router.routes?.some((route) => route.id === node.route?.branch)
      ) {
        throw new Error(`Graph node ${node.id} has an invalid router binding`);
      }
    }
    for (const route of node.routes ?? []) {
      for (const reference of route.when ? graphConditionReferences(route.when) : []) {
        if (!(node.dependsOn ?? []).includes(reference))
          throw new Error(`Graph router ${node.id} route must reference a dependency`);
      }
    }
  }
  const remaining = new Map(nodes.map((node) => [node.id, new Set(node.dependsOn ?? [])]));
  const ready = nodes.filter((node) => !node.dependsOn?.length).map((node) => node.id);
  let visited = 0;
  while (ready.length) {
    const id = ready.shift()!;
    visited++;
    remaining.delete(id);
    for (const [candidate, dependencies] of remaining)
      if (dependencies.delete(id) && dependencies.size === 0) ready.push(candidate);
  }
  if (visited !== nodes.length) throw new Error("Graph contains a dependency cycle");
  const maxConcurrency = value.maxConcurrency ?? 1;
  if (
    typeof maxConcurrency !== "number" ||
    !Number.isSafeInteger(maxConcurrency) ||
    maxConcurrency < 1 ||
    maxConcurrency > MAX_GRAPH_CONCURRENCY
  ) {
    throw new Error(`Graph maxConcurrency must be 1 to ${MAX_GRAPH_CONCURRENCY}`);
  }
  const failurePolicy = value.failurePolicy ?? "stop";
  if (failurePolicy !== "stop" && failurePolicy !== "continue") throw new Error("Graph failurePolicy is invalid");
  if (
    value.costBudgetUsd !== undefined &&
    (typeof value.costBudgetUsd !== "number" || !Number.isFinite(value.costBudgetUsd) || value.costBudgetUsd <= 0)
  ) {
    throw new Error("Graph costBudgetUsd must be positive and finite");
  }
  if (
    value.tokenBudget !== undefined &&
    (typeof value.tokenBudget !== "number" || !Number.isSafeInteger(value.tokenBudget) || value.tokenBudget < 1)
  ) {
    throw new Error("Graph tokenBudget must be a positive safe integer");
  }
  const definition: EngineeringGraphDefinition = {
    graphId: value.graphId,
    nodes,
    maxConcurrency,
    failurePolicy,
    ...(typeof value.costBudgetUsd === "number" ? { costBudgetUsd: value.costBudgetUsd } : {}),
    ...(typeof value.tokenBudget === "number" ? { tokenBudget: value.tokenBudget } : {}),
  };
  if (depth === 0 && graphNodeCount(definition) > MAX_GRAPH_NODES) {
    throw new Error(`Graph and its subgraphs may contain at most ${MAX_GRAPH_NODES} nodes in total`);
  }
  if (depth === 0 && Buffer.byteLength(JSON.stringify(definition)) > MAX_GRAPH_DEFINITION_BYTES) {
    throw new Error(`Graph definition exceeds ${MAX_GRAPH_DEFINITION_BYTES} bytes`);
  }
  return definition;
}

export function graphDefinitionFingerprint(
  definition: EngineeringGraphDefinition,
  workspaces: ReadonlyMap<string, string>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ definition, workspaces: [...workspaces].sort(([left], [right]) => left.localeCompare(right)) }),
    )
    .digest("hex");
}
