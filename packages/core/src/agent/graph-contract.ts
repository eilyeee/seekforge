import { createHash } from "node:crypto";
import { isRecord } from "../util/guards.js";
import { isSafeLoopDagRelativePath, isValidLoopDagId } from "./loop-dag-validation.js";
import { isDenseArray } from "./orchestration.js";
import { isValidOrchestrationResourceId } from "./orchestration-scheduler.js";
import { MAX_LOOP_VERIFICATION_STAGES, parseLoopVerificationPlan } from "./loop-options-contract.js";
import type { GraphRetryPolicy } from "./graph-retry-policy.js";
import type { LoopOptions, LoopVerificationStage } from "./auto-loop.js";
import { isLoopFailureCategory, validateLoopModelRoutes } from "./loop-model-routing.js";
import { compareByCodePoints } from "@seekforge/shared";

export const MAX_GRAPH_NODES = 128;
export const MAX_GRAPH_DEPTH = 4;
export const MAX_GRAPH_CONCURRENCY = 8;
export const MAX_GRAPH_RESOURCE_CAPACITIES = 64;
export const MAX_GRAPH_RESOURCE_CAPACITY = 64;
export const MAX_GRAPH_DEFINITION_BYTES = 256 * 1024;
export const MAX_GRAPH_NODE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const MAX_GRAPH_HISTORY_SEGMENTS = 3;
export const ENGINEERING_GRAPH_FAN_IN_WORKTREE_ID = "@fan-in";
export const MAX_GRAPH_LOOP_VERIFICATION_STAGES = MAX_LOOP_VERIFICATION_STAGES;
export const MAX_GRAPH_LOOP_ITERATIONS = 1_000;
export const MAX_GRAPH_NODE_OUTPUT_PATHS = 32;
export const MAX_GRAPH_NODE_BUDGET_WEIGHT = 1_000;

export type GraphNodeKind =
  | "agent"
  | "loop"
  | "function"
  | "map"
  | "join"
  | "router"
  | "gate"
  | "subgraph"
  | "wait"
  | "compensation"
  | "remote";
export type GraphNodeStatus = "passed" | "failed" | "skipped" | "waiting_approval" | "waiting_signal";
export type GraphRunStatus = "running" | "paused" | "passed" | "failed" | "cancelled";
export type GraphCondition =
  | { nodeId: string; status: GraphNodeStatus }
  | { all: GraphCondition[] }
  | { any: GraphCondition[] }
  | { not: GraphCondition };

export type GraphRoute = { id: string; when?: GraphCondition };
export type GraphValueType = "string" | "number" | "boolean" | "object" | "array" | "null";
export type GraphValueSchema = {
  type: GraphValueType;
  required?: string[];
  properties?: Record<string, GraphValueSchema>;
  items?: GraphValueSchema;
  enum?: Array<string | number | boolean | null>;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean;
};
export type GraphInputBinding = { nodeId: string; pointer?: string; schema?: GraphValueSchema };

/**
 * The Loop options a Graph `loop` node may declare, chosen so a node can shape
 * how its child Loop works without taking anything the Graph runtime owns.
 *
 * Deliberately absent: `task`, `workspace`, `verifyCommand`, `approvalMode`
 * and `priority` (the node already owns them), and `signal`, `onEvent`,
 * `control`, `loopId`, `persist`, `resumeState`, `parentGraph`, `abortStatus`,
 * `workspaceGuard`, `recoveryAttemptId` and `verify` (the Graph owns them). A
 * node able to override those would detach its child Loop from the durable
 * identity and checkpoint the Graph promises across resumes; `verifierId`
 * covers the injectable verifier through a registry instead.
 *
 * `runAutoLoop` stays the owner of Loop runtime semantics. This contract owns
 * only what a durable definition may declare and how far each value may go, so
 * an unrunnable definition fails before any lease, provider, or checkpoint.
 */
export const GRAPH_LOOP_OPTION_KEYS = [
  "maxIterations",
  "verificationPlan",
  "autoVerificationPlan",
  "stablePasses",
  "flakyRetries",
  "maxNoProgressRecoveries",
  "rollbackOnRegression",
  "adaptiveBudget",
  "maxVerifyRuns",
  "verifyTimeoutMs",
  "agentTimeoutMs",
  "maxAgentRetries",
  "costBudgetUsd",
  "tokenBudget",
  "maxDurationMs",
  "model",
  "planModel",
  "modelByFailureCategory",
  "modelRoutesByFailureCategory",
  "modelEscalationThreshold",
  "codeReview",
  "escalateOnFailure",
  "requirementMode",
  "approveRequirements",
] as const;

export type GraphLoopOptions = Pick<LoopOptions, (typeof GRAPH_LOOP_OPTION_KEYS)[number]>;

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
  executor?: string;
  executorProtocolVersion?: 1;
  requiresCancellation?: boolean;
  /** Explicit, typed data-flow edges resolved from direct dependencies. */
  inputs?: Record<string, GraphInputBinding>;
  outputSchema?: GraphValueSchema;
  /** Bounded dynamic fan-out source for map nodes. */
  source?: GraphInputBinding;
  maxItems?: number;
  mapConcurrency?: number;
  /** Execute each map item through a registered handler, Agent, or autonomous Loop. */
  mapKind?: "handler" | "agent" | "loop";
  /** Number of passed dependencies required by a join node. */
  quorum?: number;
  /** Higher-priority ready nodes are scheduled first. */
  priority?: number;
  resources?: string[];
  /** Compensation nodes run only after one of these nodes passed and the main graph failed. */
  compensates?: string[];
  waitFor?: { signal?: string; notBefore?: string; expiresAt?: string };
  verifyArtifacts?: boolean;
  routes?: GraphRoute[];
  graph?: EngineeringGraphDefinition;
  maxRetries?: number;
  retryPolicy?: GraphRetryPolicy;
  timeoutMs?: number;
  /** Absolute start deadline; a node that has not started by then fails closed. */
  deadlineAt?: string;
  /** Bounded Loop configuration forwarded to this node's child Loop. */
  loopOptions?: GraphLoopOptions;
  /** Registered verifier that replaces the shell verifier for this node's Loop. */
  verifierId?: string;
  /** Relative regular files a passing node promises to produce, captured as artifacts. */
  outputPaths?: string[];
  /** Relative share of the remaining cost/token budget. Default 1. */
  budgetWeight?: number;
  /** Overrides the graph-wide policy when this node ultimately fails. */
  failurePolicy?: "stop" | "continue";
};

export type EngineeringGraphDefinition = {
  graphId: string;
  nodes: GraphNode[];
  maxConcurrency?: number;
  failurePolicy?: "stop" | "continue";
  costBudgetUsd?: number;
  tokenBudget?: number;
  /** Cumulative active execution time across durable resumes. */
  maxDurationMs?: number;
  resourceCapacities?: Record<string, number>;
  adaptiveScheduling?: boolean;
  /** Reweight ready-node budget shares from bounded historical observations. */
  predictiveBudget?: boolean;
  /** Waiting ready nodes gain one priority point per interval, capped at 20. */
  priorityAgingMs?: number;
  managedWorktrees?: { integrateDependencies: boolean; limit: number };
  fanIn?: { verifyCommand: string; maxIterations: number };
};

export function graphNodeIsEffectful(node: Pick<GraphNode, "kind">): boolean {
  return node.kind !== "gate" && node.kind !== "router" && node.kind !== "join" && node.kind !== "wait";
}

export function isValidEngineeringGraphNodePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  const parts = value.split("/");
  return parts.length > 0 && parts.length <= MAX_GRAPH_DEPTH + 1 && parts.every(isValidLoopDagId);
}

export function engineeringSubgraphStateId(parentGraphId: string, nodeId: string, childGraphId: string): string {
  if (![parentGraphId, nodeId, childGraphId].every(isValidLoopDagId)) {
    throw new Error("Subgraph state identity requires safe graph and node ids");
  }
  const suffix = createHash("sha256").update(`${parentGraphId}\0${nodeId}\0${childGraphId}`).digest("hex").slice(0, 16);
  const result = `${childGraphId.slice(0, 40)}-${suffix}`;
  if (!isValidLoopDagId(result)) throw new Error("Subgraph state identity is invalid");
  return result;
}

export function engineeringGraphNeedsAgentRuntime(definition: EngineeringGraphDefinition): boolean {
  return definition.nodes.some(
    (node) =>
      node.kind === "agent" ||
      node.kind === "loop" ||
      (node.kind === "map" && (node.mapKind === "agent" || node.mapKind === "loop")) ||
      (node.graph !== undefined && engineeringGraphNeedsAgentRuntime(node.graph)),
  );
}

function graphNodeCount(definition: EngineeringGraphDefinition): number {
  return definition.nodes.reduce((total, node) => total + 1 + (node.graph ? graphNodeCount(node.graph) : 0), 0);
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
      value.status === "waiting_approval" ||
      value.status === "waiting_signal")
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

export function parseGraphValueSchema(value: unknown, label = "Graph value schema", depth = 0): GraphValueSchema {
  const types: GraphValueType[] = ["string", "number", "boolean", "object", "array", "null"];
  if (depth > 8 || !isRecord(value) || !types.includes(value.type as GraphValueType)) {
    throw new Error(`${label} is invalid or too deeply nested`);
  }
  const type = value.type as GraphValueType;
  const required = value.required;
  if (
    required !== undefined &&
    (!isDenseArray(required) ||
      required.length > 32 ||
      new Set(required).size !== required.length ||
      !required.every((name) => typeof name === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)))
  ) {
    throw new Error(`${label} required fields are invalid`);
  }
  if (required !== undefined && type !== "object") throw new Error(`${label} required fields need object type`);
  let properties: Record<string, GraphValueSchema> | undefined;
  if (value.properties !== undefined) {
    if (type !== "object" || !isRecord(value.properties) || Object.keys(value.properties).length > 32) {
      throw new Error(`${label} properties need object type`);
    }
    properties = Object.create(null) as Record<string, GraphValueSchema>;
    for (const [name, child] of Object.entries(value.properties)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error(`${label} property name is invalid`);
      properties[name] = parseGraphValueSchema(child, `${label}.${name}`, depth + 1);
    }
  }
  const items = value.items === undefined ? undefined : parseGraphValueSchema(value.items, `${label} items`, depth + 1);
  if (items && type !== "array") throw new Error(`${label} items need array type`);
  const enumValues = value.enum;
  if (
    enumValues !== undefined &&
    (!isDenseArray(enumValues) ||
      enumValues.length === 0 ||
      enumValues.length > 32 ||
      enumValues.some(
        (item) =>
          (item !== null && !["string", "number", "boolean"].includes(typeof item)) ||
          (typeof item === "number" && !Number.isFinite(item)) ||
          (item === null ? type !== "null" : typeof item !== type),
      ))
  ) {
    throw new Error(`${label} enum is invalid`);
  }
  // Normalize signed zero before fingerprinting because JSON persists both
  // forms as 0 and resumed schema checks must preserve the same semantics.
  const normalizedEnum = enumValues?.map((item) => (typeof item === "number" && Object.is(item, -0) ? 0 : item));
  for (const key of ["minItems", "maxItems"] as const) {
    const count = value[key];
    if (count !== undefined && (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 1_024)) {
      throw new Error(`${label} ${key} is invalid`);
    }
    if (count !== undefined && type !== "array") throw new Error(`${label} ${key} needs array type`);
  }
  if (
    value.minItems !== undefined &&
    value.maxItems !== undefined &&
    (value.minItems as number) > (value.maxItems as number)
  ) {
    throw new Error(`${label} item bounds are invalid`);
  }
  if (
    value.additionalProperties !== undefined &&
    (type !== "object" || typeof value.additionalProperties !== "boolean")
  ) {
    throw new Error(`${label} additionalProperties needs object type`);
  }
  return {
    type,
    ...(required ? { required: [...(required as string[])] } : {}),
    ...(properties ? { properties } : {}),
    ...(items ? { items } : {}),
    ...(normalizedEnum ? { enum: normalizedEnum as Array<string | number | boolean | null> } : {}),
    ...(typeof value.minItems === "number" ? { minItems: value.minItems } : {}),
    ...(typeof value.maxItems === "number" ? { maxItems: value.maxItems } : {}),
    ...(typeof value.additionalProperties === "boolean" ? { additionalProperties: value.additionalProperties } : {}),
  };
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

/**
 * Parses the declared verification pipeline. `runAutoLoop` re-validates it, but
 * a Graph must reject an unrunnable plan while the parse is still pure, so the
 * bounds and the definition-local stage graph are checked here too — both sides
 * run the one owner of those rules (`loop-options-contract.ts`), each at the
 * moment its own contract requires. A graph definition is authored text, so
 * unknown stage fields are a hard error here and every declared duration is
 * bounded like the rest of the node.
 */
function parseGraphLoopVerificationPlan(value: unknown, label: string): LoopVerificationStage[] {
  return parseLoopVerificationPlan(value, {
    label,
    rejectUnknownFields: true,
    maxTimeoutMs: MAX_GRAPH_NODE_TIMEOUT_MS,
  });
}

/** Parses the bounded Loop configuration a `loop` node may declare. */
export function parseGraphLoopOptions(value: unknown, label = "Graph loop options"): GraphLoopOptions {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set<string>(GRAPH_LOOP_OPTION_KEYS);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} declares an unsupported option: ${key}`);
  }
  if (value.autoVerificationPlan === true && value.verificationPlan !== undefined) {
    throw new Error(`${label} cannot combine autoVerificationPlan with verificationPlan`);
  }
  for (const key of [
    "autoVerificationPlan",
    "rollbackOnRegression",
    "adaptiveBudget",
    "codeReview",
    "escalateOnFailure",
    "approveRequirements",
  ] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") throw new Error(`${label} ${key} must be boolean`);
  }
  for (const key of ["model", "planModel"] as const) {
    const model = value[key];
    if (model !== undefined && (typeof model !== "string" || !model.trim() || model.length > 256)) {
      throw new Error(`${label} ${key} must be a bounded non-empty string`);
    }
  }
  if (
    value.requirementMode !== undefined &&
    value.requirementMode !== "quick" &&
    value.requirementMode !== "analyze" &&
    value.requirementMode !== "confirm"
  ) {
    throw new Error(`${label} requirementMode is invalid`);
  }
  if (
    value.costBudgetUsd !== undefined &&
    (typeof value.costBudgetUsd !== "number" || !Number.isFinite(value.costBudgetUsd) || value.costBudgetUsd <= 0)
  ) {
    throw new Error(`${label} costBudgetUsd must be positive and finite`);
  }
  let modelByFailureCategory: Record<string, string> | undefined;
  if (value.modelByFailureCategory !== undefined) {
    if (!isRecord(value.modelByFailureCategory) || Object.keys(value.modelByFailureCategory).length > 16) {
      throw new Error(`${label} modelByFailureCategory must be a bounded object`);
    }
    modelByFailureCategory = Object.create(null) as Record<string, string>;
    for (const [category, model] of Object.entries(value.modelByFailureCategory)) {
      if (!isLoopFailureCategory(category) || typeof model !== "string" || !model.trim() || model.length > 256) {
        throw new Error(`${label} modelByFailureCategory contains an invalid category or model`);
      }
      modelByFailureCategory[category] = model;
    }
  }
  if (value.modelRoutesByFailureCategory !== undefined) validateLoopModelRoutes(value.modelRoutesByFailureCategory);
  if (value.modelEscalationThreshold !== undefined && value.modelRoutesByFailureCategory === undefined) {
    throw new Error(`${label} modelEscalationThreshold requires modelRoutesByFailureCategory`);
  }
  const integer = (key: (typeof GRAPH_LOOP_OPTION_KEYS)[number], min: number, max: number): number | undefined =>
    value[key] === undefined ? undefined : boundedInteger(value[key], `${label} ${key}`, min, max);
  return {
    ...(value.maxIterations !== undefined
      ? { maxIterations: integer("maxIterations", 1, MAX_GRAPH_LOOP_ITERATIONS) }
      : {}),
    ...(value.verificationPlan !== undefined
      ? { verificationPlan: parseGraphLoopVerificationPlan(value.verificationPlan, `${label} verificationPlan`) }
      : {}),
    ...(typeof value.autoVerificationPlan === "boolean" ? { autoVerificationPlan: value.autoVerificationPlan } : {}),
    ...(value.stablePasses !== undefined ? { stablePasses: integer("stablePasses", 1, 5) } : {}),
    ...(value.flakyRetries !== undefined ? { flakyRetries: integer("flakyRetries", 0, 5) } : {}),
    ...(value.maxNoProgressRecoveries !== undefined
      ? { maxNoProgressRecoveries: integer("maxNoProgressRecoveries", 0, 5) }
      : {}),
    ...(typeof value.rollbackOnRegression === "boolean" ? { rollbackOnRegression: value.rollbackOnRegression } : {}),
    ...(typeof value.adaptiveBudget === "boolean" ? { adaptiveBudget: value.adaptiveBudget } : {}),
    ...(value.maxVerifyRuns !== undefined ? { maxVerifyRuns: integer("maxVerifyRuns", 1, 10_000) } : {}),
    ...(value.verifyTimeoutMs !== undefined
      ? { verifyTimeoutMs: integer("verifyTimeoutMs", 1, MAX_GRAPH_NODE_TIMEOUT_MS) }
      : {}),
    ...(value.agentTimeoutMs !== undefined
      ? { agentTimeoutMs: integer("agentTimeoutMs", 1, MAX_GRAPH_NODE_TIMEOUT_MS) }
      : {}),
    ...(value.maxAgentRetries !== undefined ? { maxAgentRetries: integer("maxAgentRetries", 0, 5) } : {}),
    ...(typeof value.costBudgetUsd === "number" ? { costBudgetUsd: value.costBudgetUsd } : {}),
    ...(value.tokenBudget !== undefined ? { tokenBudget: integer("tokenBudget", 1, Number.MAX_SAFE_INTEGER) } : {}),
    ...(value.maxDurationMs !== undefined
      ? { maxDurationMs: integer("maxDurationMs", 1, MAX_GRAPH_NODE_TIMEOUT_MS) }
      : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.planModel === "string" ? { planModel: value.planModel } : {}),
    ...(modelByFailureCategory ? { modelByFailureCategory } : {}),
    ...(value.modelRoutesByFailureCategory !== undefined
      ? {
          modelRoutesByFailureCategory: Object.fromEntries(
            Object.entries(value.modelRoutesByFailureCategory as Record<string, string[]>).map(([category, chain]) => [
              category,
              [...chain],
            ]),
          ),
        }
      : {}),
    ...(value.modelEscalationThreshold !== undefined
      ? { modelEscalationThreshold: integer("modelEscalationThreshold", 1, 8) }
      : {}),
    ...(typeof value.codeReview === "boolean" ? { codeReview: value.codeReview } : {}),
    ...(typeof value.escalateOnFailure === "boolean" ? { escalateOnFailure: value.escalateOnFailure } : {}),
    ...(typeof value.requirementMode === "string"
      ? { requirementMode: value.requirementMode as GraphLoopOptions["requirementMode"] }
      : {}),
    ...(typeof value.approveRequirements === "boolean" ? { approveRequirements: value.approveRequirements } : {}),
  };
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

/** Kinds whose execution actually reads `inputs`; the rest must not declare them. */
const GRAPH_INPUT_CONSUMING_KINDS = new Set<GraphNodeKind>([
  "agent",
  "loop",
  "function",
  "map",
  "compensation",
  "remote",
]);

function parseNode(value: unknown, depth: number, persisted: boolean): GraphNode {
  if (!isRecord(value) || !isValidLoopDagId(value.id)) throw new Error("Every Graph node requires a safe id");
  const kinds: GraphNodeKind[] = [
    "agent",
    "loop",
    "function",
    "map",
    "join",
    "router",
    "gate",
    "subgraph",
    "wait",
    "compensation",
    "remote",
  ];
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
  let retryPolicy: GraphRetryPolicy | undefined;
  if (value.retryPolicy !== undefined) {
    if (
      !isRecord(value.retryPolicy) ||
      Object.keys(value.retryPolicy).some(
        (key) => key !== "initialDelayMs" && key !== "maxDelayMs" && key !== "multiplier" && key !== "jitterRatio",
      ) ||
      !Number.isSafeInteger(value.retryPolicy.initialDelayMs) ||
      (value.retryPolicy.initialDelayMs as number) < 1 ||
      (value.retryPolicy.initialDelayMs as number) > MAX_GRAPH_NODE_TIMEOUT_MS ||
      !Number.isSafeInteger(value.retryPolicy.maxDelayMs) ||
      (value.retryPolicy.maxDelayMs as number) < (value.retryPolicy.initialDelayMs as number) ||
      (value.retryPolicy.maxDelayMs as number) > MAX_GRAPH_NODE_TIMEOUT_MS ||
      typeof value.retryPolicy.multiplier !== "number" ||
      !Number.isFinite(value.retryPolicy.multiplier) ||
      value.retryPolicy.multiplier < 1 ||
      value.retryPolicy.multiplier > 10 ||
      typeof value.retryPolicy.jitterRatio !== "number" ||
      !Number.isFinite(value.retryPolicy.jitterRatio) ||
      value.retryPolicy.jitterRatio < 0 ||
      value.retryPolicy.jitterRatio > 1 ||
      (value.maxRetries ?? 0) < 1
    ) {
      throw new Error(`Graph node ${value.id} retryPolicy requires retries and valid bounded delays`);
    }
    retryPolicy = {
      initialDelayMs: value.retryPolicy.initialDelayMs as number,
      maxDelayMs: value.retryPolicy.maxDelayMs as number,
      multiplier: value.retryPolicy.multiplier,
      jitterRatio: value.retryPolicy.jitterRatio,
    };
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
  if (
    value.deadlineAt !== undefined &&
    (typeof value.deadlineAt !== "string" || !Number.isFinite(Date.parse(value.deadlineAt)))
  ) {
    throw new Error(`Graph node ${value.id} deadlineAt is invalid`);
  }
  const kind = value.kind as GraphNodeKind;
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
  const mapKind = kind === "map" ? (value.mapKind ?? "handler") : undefined;
  if (mapKind !== undefined && mapKind !== "handler" && mapKind !== "agent" && mapKind !== "loop") {
    throw new Error(`Graph map node ${value.id} mapKind is invalid`);
  }
  if (
    (kind === "function" || kind === "compensation" || (kind === "map" && mapKind === "handler")) &&
    !isValidLoopDagId(value.handler)
  ) {
    throw new Error(`Graph ${kind} node ${value.id} requires a safe handler id`);
  }
  if (
    kind === "map" &&
    mapKind !== "handler" &&
    (typeof value.task !== "string" || !value.task.trim() || value.task.length > 64 * 1024)
  ) {
    throw new Error(`Graph map ${mapKind} node ${value.id} requires a bounded task`);
  }
  if (
    kind === "map" &&
    mapKind === "loop" &&
    (typeof value.verifyCommand !== "string" || !value.verifyCommand.trim() || value.verifyCommand.length > 8_192)
  ) {
    throw new Error(`Graph map loop node ${value.id} requires a bounded verifyCommand`);
  }
  if (kind === "remote" && !isValidLoopDagId(value.executor)) {
    throw new Error(`Graph remote node ${value.id} requires a safe executor id`);
  }
  if (
    (value.executorProtocolVersion !== undefined && (kind !== "remote" || value.executorProtocolVersion !== 1)) ||
    (value.requiresCancellation !== undefined && (kind !== "remote" || typeof value.requiresCancellation !== "boolean"))
  ) {
    throw new Error(`Graph remote node ${value.id} executor capabilities are invalid`);
  }
  if (
    value.priority !== undefined &&
    (!Number.isSafeInteger(value.priority) || (value.priority as number) < -10 || (value.priority as number) > 10)
  ) {
    throw new Error(`Graph node ${value.id} priority must be -10 to 10`);
  }
  const parseBinding = (input: unknown, label: string): GraphInputBinding => {
    if (
      !isRecord(input) ||
      !isValidLoopDagId(input.nodeId) ||
      (input.pointer !== undefined &&
        (typeof input.pointer !== "string" ||
          input.pointer.length > 512 ||
          !/^(?:\/(?:[^~]|~[01])*)*$/.test(input.pointer)))
    ) {
      throw new Error(`Graph node ${value.id} ${label} binding is invalid`);
    }
    return {
      nodeId: input.nodeId,
      ...(typeof input.pointer === "string" ? { pointer: input.pointer } : {}),
      ...(input.schema !== undefined
        ? { schema: parseGraphValueSchema(input.schema, `Graph node ${value.id} ${label} schema`) }
        : {}),
    };
  };
  let inputs: Record<string, GraphInputBinding> | undefined;
  if (value.inputs !== undefined) {
    // A kind that cannot read inputs used to parse and keep them while the
    // executor ignored them, so the field is inside the fingerprint of every
    // checkpoint that has one. Rejecting it when READING persisted state would
    // make those graphs unloadable — invisible to `graph list`, unresumable —
    // for a field that never did anything. New definitions are rejected; the
    // ones already on disk keep loading exactly as they were written.
    if (!persisted && !GRAPH_INPUT_CONSUMING_KINDS.has(kind)) {
      throw new Error(`Graph node ${value.id} inputs require a kind that consumes them`);
    }
    if (!isRecord(value.inputs) || Object.keys(value.inputs).length > 32) {
      throw new Error(`Graph node ${value.id} inputs are invalid`);
    }
    inputs = Object.create(null) as Record<string, GraphInputBinding>;
    for (const [name, binding] of Object.entries(value.inputs)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error(`Graph node ${value.id} input name is invalid`);
      inputs[name] = parseBinding(binding, `input ${name}`);
    }
  }
  const outputSchema =
    value.outputSchema === undefined
      ? undefined
      : parseGraphValueSchema(value.outputSchema, `Graph node ${value.id} outputSchema`);
  let source: GraphInputBinding | undefined;
  if (kind === "map") {
    source = parseBinding(value.source, "source");
    if (source.schema && source.schema.type !== "array") {
      throw new Error(`Graph map node ${value.id} source schema must be array`);
    }
    if (
      value.maxItems !== undefined &&
      (!Number.isSafeInteger(value.maxItems) || (value.maxItems as number) < 1 || (value.maxItems as number) > 64)
    ) {
      throw new Error(`Graph map node ${value.id} maxItems must be 1 to 64`);
    }
    if (
      value.mapConcurrency !== undefined &&
      (!Number.isSafeInteger(value.mapConcurrency) ||
        (value.mapConcurrency as number) < 1 ||
        (value.mapConcurrency as number) > 16)
    ) {
      throw new Error(`Graph map node ${value.id} mapConcurrency must be 1 to 16`);
    }
    if (mapKind !== "handler" && value.mapConcurrency !== undefined && value.mapConcurrency !== 1) {
      throw new Error(`Graph map ${mapKind} node ${value.id} requires mapConcurrency 1`);
    }
  } else if (
    value.source !== undefined ||
    value.maxItems !== undefined ||
    value.mapConcurrency !== undefined ||
    value.mapKind !== undefined
  ) {
    throw new Error(`Graph node ${value.id} source/maxItems/mapConcurrency/mapKind require map kind`);
  }
  if (kind === "join") {
    if (
      dependsOn.length === 0 ||
      (value.quorum !== undefined &&
        (!Number.isSafeInteger(value.quorum) ||
          (value.quorum as number) < 1 ||
          (value.quorum as number) > dependsOn.length))
    ) {
      throw new Error(`Graph join node ${value.id} quorum is invalid`);
    }
  } else if (value.quorum !== undefined) {
    throw new Error(`Graph node ${value.id} quorum requires join kind`);
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
  let resources: string[] | undefined;
  if (value.resources !== undefined) {
    if (
      !isDenseArray(value.resources) ||
      value.resources.length === 0 ||
      value.resources.length > 32 ||
      new Set(value.resources).size !== value.resources.length ||
      !value.resources.every(isValidOrchestrationResourceId)
    ) {
      throw new Error(`Graph node ${value.id} resources must be unique safe names`);
    }
    resources = [...value.resources] as string[];
  }
  let compensates: string[] | undefined;
  if (kind === "compensation") {
    if (
      !isDenseArray(value.compensates) ||
      value.compensates.length === 0 ||
      value.compensates.length > 32 ||
      new Set(value.compensates).size !== value.compensates.length ||
      !value.compensates.every(isValidLoopDagId)
    ) {
      throw new Error(`Graph compensation node ${value.id} requires unique target ids`);
    }
    compensates = [...value.compensates] as string[];
  } else if (value.compensates !== undefined) {
    throw new Error(`Graph node ${value.id} compensates requires compensation kind`);
  }
  let waitFor: GraphNode["waitFor"];
  if (kind === "wait") {
    if (!isRecord(value.waitFor)) throw new Error(`Graph wait node ${value.id} requires waitFor`);
    const signal = value.waitFor.signal;
    const notBefore = value.waitFor.notBefore;
    const expiresAt = value.waitFor.expiresAt;
    if (
      (signal !== undefined && !isValidLoopDagId(signal)) ||
      (notBefore !== undefined && (typeof notBefore !== "string" || !Number.isFinite(Date.parse(notBefore)))) ||
      (expiresAt !== undefined && (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)))) ||
      (signal === undefined && notBefore === undefined) ||
      (notBefore !== undefined &&
        expiresAt !== undefined &&
        Date.parse(expiresAt as string) <= Date.parse(notBefore as string))
    ) {
      throw new Error(`Graph wait node ${value.id} waitFor is invalid`);
    }
    waitFor = {
      ...(typeof signal === "string" ? { signal } : {}),
      ...(typeof notBefore === "string" ? { notBefore } : {}),
      ...(typeof expiresAt === "string" ? { expiresAt } : {}),
    };
  } else if (value.waitFor !== undefined) {
    throw new Error(`Graph node ${value.id} waitFor requires wait kind`);
  }
  if (value.verifyArtifacts !== undefined && typeof value.verifyArtifacts !== "boolean") {
    throw new Error(`Graph node ${value.id} verifyArtifacts must be boolean`);
  }
  const runsLoop = kind === "loop" || (kind === "map" && mapKind === "loop");
  let loopOptions: GraphLoopOptions | undefined;
  if (value.loopOptions !== undefined) {
    if (!runsLoop) throw new Error(`Graph node ${value.id} loopOptions require a loop node`);
    loopOptions = parseGraphLoopOptions(value.loopOptions, `Graph node ${value.id} loopOptions`);
  }
  if (value.verifierId !== undefined && (!runsLoop || !isValidLoopDagId(value.verifierId))) {
    throw new Error(`Graph node ${value.id} verifierId requires a loop node and a safe id`);
  }
  let outputPaths: string[] | undefined;
  if (value.outputPaths !== undefined) {
    if (
      (kind !== "loop" && kind !== "agent") ||
      !isDenseArray(value.outputPaths) ||
      value.outputPaths.length === 0 ||
      value.outputPaths.length > MAX_GRAPH_NODE_OUTPUT_PATHS ||
      new Set(value.outputPaths).size !== value.outputPaths.length ||
      !value.outputPaths.every(isSafeLoopDagRelativePath)
    ) {
      throw new Error(
        `Graph node ${value.id} outputPaths must be 1 to ${MAX_GRAPH_NODE_OUTPUT_PATHS} unique safe relative paths on an agent or loop node`,
      );
    }
    outputPaths = [...value.outputPaths] as string[];
  }
  if (
    value.budgetWeight !== undefined &&
    (typeof value.budgetWeight !== "number" ||
      !Number.isFinite(value.budgetWeight) ||
      value.budgetWeight <= 0 ||
      value.budgetWeight > MAX_GRAPH_NODE_BUDGET_WEIGHT)
  ) {
    throw new Error(
      `Graph node ${value.id} budgetWeight must be greater than 0 and at most ${MAX_GRAPH_NODE_BUDGET_WEIGHT}`,
    );
  }
  if (value.failurePolicy !== undefined && value.failurePolicy !== "stop" && value.failurePolicy !== "continue") {
    throw new Error(`Graph node ${value.id} failurePolicy is invalid`);
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
    ...(typeof value.executor === "string" ? { executor: value.executor } : {}),
    ...(value.executorProtocolVersion === 1 ? { executorProtocolVersion: 1 as const } : {}),
    ...(typeof value.requiresCancellation === "boolean" ? { requiresCancellation: value.requiresCancellation } : {}),
    ...(inputs ? { inputs } : {}),
    ...(outputSchema ? { outputSchema } : {}),
    ...(source ? { source } : {}),
    ...(typeof value.maxItems === "number" ? { maxItems: value.maxItems } : {}),
    ...(typeof value.mapConcurrency === "number" ? { mapConcurrency: value.mapConcurrency } : {}),
    // Keep the legacy handler default implicit so loading an old checkpoint
    // does not rewrite its durable definition fingerprint.
    ...(kind === "map" && value.mapKind !== undefined ? { mapKind } : {}),
    ...(typeof value.quorum === "number" ? { quorum: value.quorum } : {}),
    ...(typeof value.priority === "number" ? { priority: value.priority } : {}),
    ...(resources ? { resources } : {}),
    ...(compensates ? { compensates } : {}),
    ...(waitFor ? { waitFor } : {}),
    ...(typeof value.verifyArtifacts === "boolean" ? { verifyArtifacts: value.verifyArtifacts } : {}),
    ...(routes ? { routes } : {}),
    ...(kind === "subgraph" ? { graph: parseEngineeringGraphDefinition(value.graph, depth + 1, persisted) } : {}),
    ...(typeof value.maxRetries === "number" ? { maxRetries: value.maxRetries } : {}),
    ...(retryPolicy ? { retryPolicy } : {}),
    ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}),
    ...(typeof value.deadlineAt === "string" ? { deadlineAt: value.deadlineAt } : {}),
    ...(loopOptions ? { loopOptions } : {}),
    ...(typeof value.verifierId === "string" ? { verifierId: value.verifierId } : {}),
    ...(outputPaths ? { outputPaths } : {}),
    ...(typeof value.budgetWeight === "number" ? { budgetWeight: value.budgetWeight } : {}),
    ...(value.failurePolicy === "stop" || value.failurePolicy === "continue"
      ? { failurePolicy: value.failurePolicy }
      : {}),
  };
}

/**
 * `persisted` relaxes checks that would reject a definition this codec itself
 * once produced. Pass it ONLY when decoding a stored checkpoint; a definition
 * arriving from a user, a file or the wire must face the current rules.
 */
export function parseEngineeringGraphDefinition(
  value: unknown,
  depth = 0,
  persisted = false,
): EngineeringGraphDefinition {
  if (depth > MAX_GRAPH_DEPTH) throw new Error(`Graph nesting exceeds ${MAX_GRAPH_DEPTH}`);
  if (!isRecord(value) || !isValidLoopDagId(value.graphId) || !isDenseArray(value.nodes)) {
    throw new Error("Graph definition requires graphId and nodes");
  }
  if (value.nodes.length === 0 || value.nodes.length > MAX_GRAPH_NODES) {
    throw new Error(`Graph must contain 1 to ${MAX_GRAPH_NODES} nodes`);
  }
  const nodes = value.nodes.map((node) => parseNode(node, depth, persisted));
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
    if (node.kind === "compensation") {
      for (const target of node.compensates ?? []) {
        const compensated = byId.get(target);
        if (
          !compensated ||
          compensated.kind === "compensation" ||
          target === node.id ||
          !(node.dependsOn ?? []).includes(target)
        ) {
          throw new Error(`Graph compensation node ${node.id} has invalid target: ${target}`);
        }
      }
    } else if ((node.dependsOn ?? []).some((dependency) => byId.get(dependency)?.kind === "compensation")) {
      throw new Error(`Graph main node ${node.id} cannot depend on compensation work`);
    }
    for (const [name, binding] of Object.entries(node.inputs ?? {})) {
      if (!(node.dependsOn ?? []).includes(binding.nodeId)) {
        throw new Error(`Graph node ${node.id} input ${name} must reference a dependency`);
      }
    }
    if (node.source && !(node.dependsOn ?? []).includes(node.source.nodeId)) {
      throw new Error(`Graph map node ${node.id} source must reference a dependency`);
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
  let resourceCapacities: Record<string, number> | undefined;
  if (value.resourceCapacities !== undefined) {
    if (
      !isRecord(value.resourceCapacities) ||
      Object.keys(value.resourceCapacities).length > MAX_GRAPH_RESOURCE_CAPACITIES
    ) {
      throw new Error("Graph resourceCapacities is invalid");
    }
    resourceCapacities = Object.create(null) as Record<string, number>;
    for (const [resource, capacity] of Object.entries(value.resourceCapacities)) {
      if (
        !isValidOrchestrationResourceId(resource) ||
        !Number.isSafeInteger(capacity) ||
        (capacity as number) < 1 ||
        (capacity as number) > MAX_GRAPH_RESOURCE_CAPACITY
      ) {
        throw new Error(`Graph resource capacity is invalid: ${resource}`);
      }
      resourceCapacities[resource] = capacity as number;
    }
  }
  if (value.adaptiveScheduling !== undefined && typeof value.adaptiveScheduling !== "boolean") {
    throw new Error("Graph adaptiveScheduling must be boolean");
  }
  if (value.predictiveBudget !== undefined && typeof value.predictiveBudget !== "boolean") {
    throw new Error("Graph predictiveBudget must be boolean");
  }
  if (
    value.priorityAgingMs !== undefined &&
    (!Number.isSafeInteger(value.priorityAgingMs) ||
      (value.priorityAgingMs as number) < 1_000 ||
      (value.priorityAgingMs as number) > MAX_GRAPH_NODE_TIMEOUT_MS)
  ) {
    throw new Error(`Graph priorityAgingMs must be 1000 to ${MAX_GRAPH_NODE_TIMEOUT_MS}`);
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
  if (
    value.maxDurationMs !== undefined &&
    (!Number.isSafeInteger(value.maxDurationMs) ||
      (value.maxDurationMs as number) < 1 ||
      (value.maxDurationMs as number) > MAX_GRAPH_NODE_TIMEOUT_MS)
  ) {
    throw new Error(`Graph maxDurationMs must be 1 to ${MAX_GRAPH_NODE_TIMEOUT_MS}`);
  }
  let managedWorktrees: EngineeringGraphDefinition["managedWorktrees"];
  if (value.managedWorktrees !== undefined) {
    if (value.managedWorktrees === true) {
      managedWorktrees = { integrateDependencies: true, limit: 64 };
    } else if (
      isRecord(value.managedWorktrees) &&
      (value.managedWorktrees.integrateDependencies === undefined ||
        typeof value.managedWorktrees.integrateDependencies === "boolean") &&
      (value.managedWorktrees.limit === undefined ||
        (Number.isSafeInteger(value.managedWorktrees.limit) &&
          (value.managedWorktrees.limit as number) >= 1 &&
          (value.managedWorktrees.limit as number) <= 256))
    ) {
      managedWorktrees = {
        integrateDependencies: value.managedWorktrees.integrateDependencies !== false,
        limit: (value.managedWorktrees.limit as number | undefined) ?? 64,
      };
    } else {
      throw new Error("Graph managedWorktrees configuration is invalid");
    }
    const hasExplicitWorkspace = (graphNodes: readonly GraphNode[]): boolean =>
      graphNodes.some((node) => node.workspace !== undefined || (node.graph && hasExplicitWorkspace(node.graph.nodes)));
    if (hasExplicitWorkspace(nodes)) throw new Error("Graph managedWorktrees cannot be combined with node workspaces");
  }
  let fanIn: EngineeringGraphDefinition["fanIn"];
  if (value.fanIn !== undefined) {
    if (!managedWorktrees || !isRecord(value.fanIn)) {
      throw new Error("Graph fanIn requires managedWorktrees");
    }
    if (
      typeof value.fanIn.verifyCommand !== "string" ||
      !value.fanIn.verifyCommand.trim() ||
      value.fanIn.verifyCommand.length > 8_192 ||
      (value.fanIn.maxIterations !== undefined &&
        (!Number.isSafeInteger(value.fanIn.maxIterations) ||
          (value.fanIn.maxIterations as number) < 1 ||
          (value.fanIn.maxIterations as number) > 5))
    ) {
      throw new Error("Graph fanIn configuration is invalid");
    }
    fanIn = {
      verifyCommand: value.fanIn.verifyCommand,
      maxIterations: (value.fanIn.maxIterations as number | undefined) ?? 1,
    };
  }
  const definition: EngineeringGraphDefinition = {
    graphId: value.graphId,
    nodes,
    maxConcurrency,
    failurePolicy,
    ...(typeof value.costBudgetUsd === "number" ? { costBudgetUsd: value.costBudgetUsd } : {}),
    ...(typeof value.tokenBudget === "number" ? { tokenBudget: value.tokenBudget } : {}),
    ...(typeof value.maxDurationMs === "number" ? { maxDurationMs: value.maxDurationMs } : {}),
    ...(resourceCapacities ? { resourceCapacities } : {}),
    ...(typeof value.adaptiveScheduling === "boolean" ? { adaptiveScheduling: value.adaptiveScheduling } : {}),
    ...(typeof value.predictiveBudget === "boolean" ? { predictiveBudget: value.predictiveBudget } : {}),
    ...(typeof value.priorityAgingMs === "number" ? { priorityAgingMs: value.priorityAgingMs } : {}),
    ...(managedWorktrees ? { managedWorktrees } : {}),
    ...(fanIn ? { fanIn } : {}),
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
  return rawGraphDefinitionFingerprint(canonicalFingerprintDefinition(definition), workspaces);
}

function canonicalFingerprintDefinition(definition: EngineeringGraphDefinition): EngineeringGraphDefinition {
  const normalized = { ...definition };
  normalized.nodes = definition.nodes.map((node) => {
    const normalizedNode = { ...node };
    if (normalizedNode.kind === "map" && normalizedNode.mapKind === "handler") delete normalizedNode.mapKind;
    if (normalizedNode.graph) normalizedNode.graph = canonicalFingerprintDefinition(normalizedNode.graph);
    return normalizedNode;
  });
  return normalized;
}

function rawGraphDefinitionFingerprint(
  definition: EngineeringGraphDefinition,
  workspaces: ReadonlyMap<string, string>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        definition,
        workspaces: [...workspaces].sort(([left], [right]) => compareByCodePoints(left, right)),
      }),
    )
    .digest("hex");
}

/** Accepts the one release that persisted the formerly implicit handler-map default. */
export function graphDefinitionFingerprintMatches(
  storedFingerprint: string,
  storedDefinition: EngineeringGraphDefinition,
  currentDefinition: EngineeringGraphDefinition,
  workspaces: ReadonlyMap<string, string>,
): boolean {
  const currentFingerprint = graphDefinitionFingerprint(currentDefinition, workspaces);
  const storedCanonicalFingerprint = graphDefinitionFingerprint(storedDefinition, workspaces);
  if (storedCanonicalFingerprint !== currentFingerprint) return false;
  return (
    storedFingerprint === storedCanonicalFingerprint ||
    storedFingerprint === rawGraphDefinitionFingerprint(storedDefinition, workspaces)
  );
}
