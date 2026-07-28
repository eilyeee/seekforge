import { lstatSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { onAbortOnce } from "../util/abort.js";
import { isRecord } from "../util/guards.js";
import { checkpointWorktree, listGitWorktrees, mergeWorktree, removeWorktree } from "../worktree.js";
import type { AgentCoreDeps } from "./loop.js";
import { runAutoLoop } from "./auto-loop.js";
import { createAgentCore } from "./loop.js";
import {
  type EngineeringGraphDefinition,
  ENGINEERING_GRAPH_FAN_IN_WORKTREE_ID,
  type GraphNode,
  graphConditionMatches,
  graphDefinitionFingerprint,
  engineeringSubgraphStateId,
  isValidEngineeringGraphNodePath,
  MAX_GRAPH_NODES,
  parseEngineeringGraphDefinition,
} from "./graph-contract.js";
import {
  type EngineeringGraphState,
  type GraphEvent,
  type GraphNodeResult,
  engineeringGraphStateExists,
  MAX_GRAPH_EVENTS,
  MAX_GRAPH_EVENT_MESSAGE_CHARS,
  MAX_GRAPH_OUTPUT_BYTES,
  MAX_GRAPH_OUTPUT_TOTAL_BYTES,
  loadEngineeringGraphState,
  saveEngineeringGraphState,
} from "./graph-state.js";
import { acquireSessionLeaseWithPreemption } from "./session-lease.js";
import { isValidLoopDagId } from "./loop-dag-validation.js";
import { acquireManagedOrchestrationWorktreeLease } from "./loop-managed-worktree.js";
import { createEngineeringGraphLogWriter, type GraphLogWriter } from "./graph-history.js";
import {
  assertNonOverlappingOrchestrationPaths,
  orchestrationDescendantClosure,
  orchestrationDependsOn,
  validateOrchestrationSelection,
} from "./orchestration.js";
import {
  managedOrchestrationWorktreeSlug,
  prepareManagedOrchestrationWorktrees,
  type ManagedOrchestrationWorktree,
} from "./orchestration-worktrees.js";

export type GraphFunctionContext = {
  node: GraphNode;
  workspace: string;
  dependencies: ReadonlyMap<string, GraphNodeResult>;
  costBudgetUsd?: number;
  tokenBudget?: number;
  signal: AbortSignal;
};

export type GraphFunctionResult = { output?: unknown; costUsd?: number; tokensUsed?: number };
export type GraphFunctionHandler = (
  context: GraphFunctionContext,
) => GraphFunctionResult | Promise<GraphFunctionResult>;

export type RunEngineeringGraphOptions = {
  workspace: string;
  resume?: boolean;
  restart?: boolean;
  persist?: boolean;
  rerunFrom?: string[];
  approvedNodeIds?: string[];
  /** Durable provenance for an internally managed child Graph checkpoint. */
  parentGraph?: { graphId: string; nodeId: string };
  /** Operational cap for this invocation; does not alter the durable definition fingerprint. */
  costBudgetUsd?: number;
  /** Operational token cap for this invocation; does not alter the durable definition fingerprint. */
  tokenBudget?: number;
  approveNode?: (
    node: GraphNode,
    completed: ReadonlyMap<string, GraphNodeResult>,
    graphId: string,
  ) => boolean | Promise<boolean>;
  handlers?: Readonly<Record<string, GraphFunctionHandler>>;
  signal?: AbortSignal;
  onEvent?: (event: GraphEvent) => void;
};

type ExecutionResult = Omit<GraphNodeResult, "id" | "kind" | "status" | "attempts" | "startedAt" | "completedAt">;

class GraphNodeExecutionError extends Error {
  constructor(
    message: string,
    readonly usage: { costUsd: number; tokensUsed: number; sessionId?: string },
  ) {
    super(message);
    this.name = "GraphNodeExecutionError";
  }
}

class GraphNodeTimeoutError extends Error {}
class GraphNodeNonRetryableError extends Error {
  constructor(
    message: string,
    readonly usage?: { costUsd: number; tokensUsed: number; sessionId?: string },
  ) {
    super(message);
  }
}

class GraphSubgraphPausedError extends Error {
  constructor(
    readonly childGraphId: string,
    readonly waitingFor: string[],
    readonly usage: { costUsd: number; tokensUsed: number },
  ) {
    super(`Subgraph ${childGraphId} is waiting for approval: ${waitingFor.join(", ")}`);
    this.name = "GraphSubgraphPausedError";
  }
}

function boundedOutput(value: unknown): unknown {
  if (value === undefined) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { truncated: true, preview: "[non-serializable Graph node output]" };
  }
  if (serialized === undefined) return { truncated: true, preview: "[unsupported Graph node output]" };
  if (Buffer.byteLength(serialized) > MAX_GRAPH_OUTPUT_BYTES) {
    return { truncated: true, preview: serialized.slice(0, 1024) };
  }
  return JSON.parse(serialized) as unknown;
}

function fitOutputBudget(value: unknown, results: ReadonlyMap<string, GraphNodeResult>): unknown {
  if (value === undefined) return undefined;
  const used = [...results.values()].reduce(
    (total, result) => total + (result.output === undefined ? 0 : Buffer.byteLength(JSON.stringify(result.output))),
    0,
  );
  const serialized = JSON.stringify(value);
  if (used + Buffer.byteLength(serialized) <= MAX_GRAPH_OUTPUT_TOTAL_BYTES) return value;
  const marker = { truncated: true };
  return used + Buffer.byteLength(JSON.stringify(marker)) <= MAX_GRAPH_OUTPUT_TOTAL_BYTES ? marker : undefined;
}

function graphHandler(options: RunEngineeringGraphOptions, id: string): GraphFunctionHandler | undefined {
  const descriptor = options.handlers ? Object.getOwnPropertyDescriptor(options.handlers, id) : undefined;
  return descriptor && "value" in descriptor && typeof descriptor.value === "function"
    ? (descriptor.value as GraphFunctionHandler)
    : undefined;
}

export function validateEngineeringGraphRunOptions(
  definition: EngineeringGraphDefinition,
  options: RunEngineeringGraphOptions,
): void {
  for (const [name, value] of [
    ["resume", options.resume],
    ["restart", options.restart],
    ["persist", options.persist],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") throw new Error(`Graph ${name} must be boolean`);
  }
  if (options.resume && options.restart) throw new Error("Graph resume and restart cannot be combined");
  if (
    options.costBudgetUsd !== undefined &&
    (typeof options.costBudgetUsd !== "number" || !Number.isFinite(options.costBudgetUsd) || options.costBudgetUsd <= 0)
  ) {
    throw new Error("Graph operational costBudgetUsd must be positive and finite");
  }
  if (
    options.tokenBudget !== undefined &&
    (typeof options.tokenBudget !== "number" || !Number.isSafeInteger(options.tokenBudget) || options.tokenBudget < 1)
  ) {
    throw new Error("Graph operational tokenBudget must be a positive safe integer");
  }
  if (
    options.parentGraph !== undefined &&
    (!isRecord(options.parentGraph) ||
      !isValidLoopDagId(options.parentGraph.graphId) ||
      !isValidLoopDagId(options.parentGraph.nodeId))
  ) {
    throw new Error("Graph parentGraph provenance is invalid");
  }
  const declaredNodes = new Set<string>();
  const gateIds = new Set<string>();
  const collectPaths = (graph: EngineeringGraphDefinition, prefix = ""): void => {
    for (const node of graph.nodes) {
      const path = `${prefix}${node.id}`;
      declaredNodes.add(path);
      if (node.kind === "gate") gateIds.add(path);
      if (node.graph) collectPaths(node.graph, `${path}/`);
    }
  };
  collectPaths(definition);
  const rerunFrom = validateOrchestrationSelection(options.rerunFrom, {
    label: "Graph rerunFrom",
    max: MAX_GRAPH_NODES,
    knownIds: declaredNodes,
    isValidId: isValidEngineeringGraphNodePath,
    allowUndefined: true,
    allowEmpty: true,
  });
  validateOrchestrationSelection(options.approvedNodeIds, {
    label: "Graph approvedNodeIds",
    max: MAX_GRAPH_NODES,
    knownIds: gateIds,
    isValidId: isValidEngineeringGraphNodePath,
    allowUndefined: true,
    allowEmpty: true,
  });
  if (rerunFrom.length && !options.resume) throw new Error("Graph rerunFrom requires resume");
  const validateHandlers = (graph: EngineeringGraphDefinition): void => {
    for (const node of graph.nodes) {
      if (node.kind === "function" && !graphHandler(options, node.handler!)) {
        throw new Error(`Graph function handler is not registered: ${node.handler}`);
      }
      if (node.graph) validateHandlers(node.graph);
    }
  };
  validateHandlers(definition);
}

export function validateEngineeringGraphWorkspaces(definition: EngineeringGraphDefinition, workspace: string): void {
  if (definition.managedWorktrees) {
    realpathSync.native(resolve(workspace));
    return;
  }
  resolveNodeWorkspaces(workspace, definition);
}

function resolveNodeWorkspaces(
  rootInput: string,
  definition: EngineeringGraphDefinition,
  overrides: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const root = realpathSync.native(resolve(rootInput));
  const workspaces = new Map<string, string>();
  const visit = (graph: EngineeringGraphDefinition, graphRoot: string, prefix: string): void => {
    for (const node of graph.nodes) {
      const key = `${prefix}${node.id}`;
      const override = overrides.get(key);
      const requested =
        override ??
        (node.workspace
          ? isAbsolute(node.workspace)
            ? node.workspace
            : resolve(graphRoot, node.workspace)
          : graphRoot);
      const rel = relative(graphRoot, resolve(requested));
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`Graph node ${key} workspace escapes the graph workspace`);
      }
      const stat = lstatSync(requested);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Graph node ${key} workspace must be a physical directory`);
      }
      const physical = realpathSync.native(requested);
      if (physical !== graphRoot && !physical.startsWith(`${graphRoot}${sep}`)) {
        throw new Error(`Graph node ${key} workspace escapes the graph workspace`);
      }
      workspaces.set(key, physical);
      if (node.graph) visit(node.graph, physical, `${key}/`);
    }
    if ((graph.maxConcurrency ?? 1) > 1) {
      const effectful = graph.nodes.filter((node) => node.kind !== "router" && node.kind !== "gate");
      for (let leftIndex = 0; leftIndex < effectful.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < effectful.length; rightIndex++) {
          const left = effectful[leftIndex]!;
          const right = effectful[rightIndex]!;
          if (orchestrationDependsOn(graph.nodes, left.id, right.id)) continue;
          if (orchestrationDependsOn(graph.nodes, right.id, left.id)) continue;
          assertNonOverlappingOrchestrationPaths(
            [workspaces.get(`${prefix}${left.id}`)!, workspaces.get(`${prefix}${right.id}`)!],
            "Concurrent effectful Graph nodes must use non-overlapping physical workspaces",
          );
        }
      }
    }
  };
  visit(definition, root, "");
  return workspaces;
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | undefined,
  parentSignal: AbortSignal | undefined,
): Promise<T> {
  const controller = new AbortController();
  const detach = onAbortOnce(parentSignal, () => controller.abort(parentSignal?.reason));
  let timer: NodeJS.Timeout | undefined;
  try {
    const running = operation(controller.signal);
    const timeout =
      timeoutMs === undefined
        ? undefined
        : new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new GraphNodeTimeoutError(`Graph node timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            timer.unref?.();
          });
    if (!timeout) return await running;
    try {
      return await Promise.race([running, timeout]);
    } catch (error) {
      if (error instanceof GraphNodeTimeoutError) {
        controller.abort(error);
        await running.catch(() => undefined);
      }
      throw error;
    }
  } finally {
    if (timer) clearTimeout(timer);
    detach();
  }
}

function retryableError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, MAX_GRAPH_EVENT_MESSAGE_CHARS)
    : String(error).slice(0, MAX_GRAPH_EVENT_MESSAGE_CHARS);
}

async function executeAgent(
  deps: AgentCoreDeps,
  node: GraphNode,
  workspace: string,
  signal: AbortSignal,
): Promise<ExecutionResult> {
  let sessionId: string | undefined;
  let output: unknown;
  let costUsd = 0;
  let tokensUsed = 0;
  let completed = false;
  for await (const event of createAgentCore(deps).runTask({
    projectPath: workspace,
    task: node.task!,
    mode: node.mode ?? "edit",
    approvalMode: node.approvalMode ?? "acceptEdits",
    signal,
  })) {
    if (event.type === "session.created") sessionId = event.sessionId;
    if (event.type === "usage.updated") {
      costUsd = event.usage.costUsd;
      tokensUsed = event.usage.promptTokens + event.usage.completionTokens;
    }
    if (event.type === "session.failed") {
      throw new GraphNodeExecutionError(event.error.message, {
        costUsd,
        tokensUsed,
        ...(sessionId ? { sessionId } : {}),
      });
    }
    if (event.type === "session.completed") {
      completed = true;
      costUsd = event.report.usage.costUsd;
      tokensUsed = event.report.usage.promptTokens + event.report.usage.completionTokens;
      output = {
        summary: event.report.summary,
        changedFiles: event.report.changedFiles,
        commandsRun: event.report.commandsRun,
        verification: event.report.verification,
      };
    }
  }
  if (!completed) {
    throw new GraphNodeExecutionError("Agent ended without a terminal event", {
      costUsd,
      tokensUsed,
      ...(sessionId ? { sessionId } : {}),
    });
  }
  return { sessionId, costUsd, tokensUsed, output: boundedOutput(output) };
}

async function executeNode(
  deps: AgentCoreDeps,
  ownerGraphId: string,
  node: GraphNode,
  workspace: string,
  completed: ReadonlyMap<string, GraphNodeResult>,
  options: RunEngineeringGraphOptions,
  costBudgetUsd: number | undefined,
  tokenBudget: number | undefined,
  signal: AbortSignal,
  attempt: number,
): Promise<ExecutionResult> {
  if (node.kind === "agent") return executeAgent(deps, node, workspace, signal);
  if (node.kind === "loop") {
    const result = await runAutoLoop(deps, {
      task: node.task!,
      workspace,
      verifyCommand: node.verifyCommand!,
      approvalMode: node.approvalMode ?? "acceptEdits",
      ...(costBudgetUsd !== undefined ? { costBudgetUsd } : {}),
      ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      ...(node.timeoutMs !== undefined ? { maxDurationMs: node.timeoutMs } : {}),
      signal,
    });
    if (result.status !== "passed") {
      throw new GraphNodeExecutionError(`Loop finished with status ${result.status}`, {
        costUsd: result.costUsd,
        tokensUsed: result.tokensUsed ?? 0,
        sessionId: result.sessionId,
      });
    }
    return {
      sessionId: result.sessionId,
      costUsd: result.costUsd,
      tokensUsed: result.tokensUsed ?? 0,
      output: boundedOutput({
        status: result.status,
        iterations: result.iterations,
        finalVerify: result.finalVerify,
        loopId: result.loopId,
      }),
    };
  }
  if (node.kind === "function") {
    const handler = graphHandler(options, node.handler!);
    if (!handler) throw new Error(`Graph function handler is not registered: ${node.handler}`);
    const result = await handler({ node, workspace, dependencies: completed, costBudgetUsd, tokenBudget, signal });
    if (result.costUsd !== undefined && (!Number.isFinite(result.costUsd) || result.costUsd < 0)) {
      throw new Error(`Graph function ${node.id} returned invalid costUsd`);
    }
    if (result.tokensUsed !== undefined && (!Number.isSafeInteger(result.tokensUsed) || result.tokensUsed < 0)) {
      throw new Error(`Graph function ${node.id} returned invalid tokensUsed`);
    }
    return {
      output: boundedOutput(result.output),
      costUsd: result.costUsd ?? 0,
      tokensUsed: result.tokensUsed ?? 0,
    };
  }
  if (node.kind === "router") {
    const branch =
      node.routes?.find((route) => route.when && graphConditionMatches(route.when, completed)) ??
      node.routes?.find((route) => route.when === undefined);
    if (!branch) throw new Error(`Graph router ${node.id} did not select a branch`);
    return { output: { branch: branch.id }, costUsd: 0, tokensUsed: 0 };
  }
  if (node.kind === "subgraph") {
    const childGraphId = engineeringSubgraphStateId(ownerGraphId, node.id, node.graph!.graphId);
    const persistedChild = options.persist === false ? null : loadEngineeringGraphState(workspace, childGraphId);
    const directRestart = options.restart === true || options.rerunFrom?.includes(node.id) === true;
    const scopedRerun = options.rerunFrom?.flatMap((id) =>
      id.startsWith(`${node.id}/`) ? [id.slice(node.id.length + 1)] : [],
    );
    if (persistedChild && !directRestart && !options.resume && attempt === 1) {
      throw new GraphNodeNonRetryableError(
        `Persisted subgraph already exists; restart the parent Graph: ${node.graph!.graphId}`,
      );
    }
    const resumeChild = !directRestart && persistedChild !== null && (options.resume === true || attempt > 1);
    let childRerun = scopedRerun ?? [];
    if (
      resumeChild &&
      childRerun.length === 0 &&
      persistedChild.status !== "passed" &&
      persistedChild.status !== "paused"
    ) {
      childRerun = persistedChild.results.filter((result) => result.status === "failed").map((result) => result.id);
    }
    const restartChild =
      directRestart || (resumeChild && persistedChild?.status === "cancelled" && childRerun.length === 0);
    const childInvalidated =
      resumeChild && !restartChild && childRerun.length > 0 && persistedChild
        ? orchestrationDescendantClosure(persistedChild.definition.nodes, [
            ...new Set(childRerun.map((id) => id.split("/", 1)[0]!)),
          ])
        : new Set<string>();
    const retainedCost =
      resumeChild && !restartChild && persistedChild
        ? persistedChild.results
            .filter((result) => !childInvalidated.has(result.id))
            .reduce((sum, result) => sum + result.costUsd, 0)
        : 0;
    const retainedTokens =
      resumeChild && !restartChild && persistedChild
        ? persistedChild.results
            .filter((result) => !childInvalidated.has(result.id))
            .reduce((sum, result) => sum + result.tokensUsed, 0)
        : 0;
    const nestedDefinition: EngineeringGraphDefinition = {
      ...node.graph!,
      graphId: childGraphId,
    };
    let nested: EngineeringGraphState;
    try {
      nested = await runEngineeringGraph(deps, nestedDefinition, {
        ...options,
        workspace,
        persist: options.persist !== false,
        resume: restartChild ? false : resumeChild,
        restart: restartChild,
        rerunFrom: resumeChild && childRerun.length > 0 ? childRerun : undefined,
        approvedNodeIds: options.approvedNodeIds?.flatMap((id) =>
          id.startsWith(`${node.id}/`) ? [id.slice(node.id.length + 1)] : [],
        ),
        parentGraph: { graphId: ownerGraphId, nodeId: node.id },
        ...(costBudgetUsd === undefined ? {} : { costBudgetUsd: retainedCost + costBudgetUsd }),
        ...(tokenBudget === undefined ? {} : { tokenBudget: retainedTokens + tokenBudget }),
        onEvent: undefined,
        signal,
      });
    } catch (error) {
      const checkpoint = options.persist === false ? null : loadEngineeringGraphState(workspace, childGraphId);
      throw new GraphNodeExecutionError(`Subgraph ${node.graph!.graphId} failed: ${retryableError(error)}`, {
        costUsd: Math.max(0, (checkpoint?.spentCost ?? retainedCost) - retainedCost),
        tokensUsed: Math.max(0, (checkpoint?.spentTokens ?? retainedTokens) - retainedTokens),
      });
    }
    if (nested.status === "paused") {
      const waitingFor = nested.results.flatMap((result) => {
        if (result.status !== "waiting_approval") return [];
        if (result.kind === "gate") return [`${node.id}/${result.id}`];
        if (result.kind === "subgraph" && isRecord(result.output) && Array.isArray(result.output.waitingFor)) {
          return result.output.waitingFor.flatMap((path) =>
            isValidEngineeringGraphNodePath(path) ? [`${node.id}/${path}`] : [],
          );
        }
        return [];
      });
      throw new GraphSubgraphPausedError(childGraphId, waitingFor, {
        costUsd: Math.max(0, nested.spentCost - retainedCost),
        tokensUsed: Math.max(0, nested.spentTokens - retainedTokens),
      });
    }
    if (nested.status !== "passed") {
      throw new GraphNodeExecutionError(`Subgraph ${node.graph!.graphId} finished with status ${nested.status}`, {
        costUsd: Math.max(0, nested.spentCost - retainedCost),
        tokensUsed: Math.max(0, nested.spentTokens - retainedTokens),
      });
    }
    return {
      costUsd: Math.max(0, nested.spentCost - retainedCost),
      tokensUsed: Math.max(0, nested.spentTokens - retainedTokens),
      output: boundedOutput({
        graphId: node.graph!.graphId,
        childGraphId: nested.graphId,
        status: nested.status,
        results: nested.results.map(({ id, kind, status, attempts, costUsd, tokensUsed }) => ({
          id,
          kind,
          status,
          attempts,
          costUsd,
          tokensUsed,
        })),
      }),
    };
  }
  throw new Error(`Graph gate ${node.id} must be resolved by the scheduler`);
}

export async function runEngineeringGraph(
  deps: AgentCoreDeps,
  input: unknown,
  options: RunEngineeringGraphOptions,
): Promise<EngineeringGraphState> {
  const definition = parseEngineeringGraphDefinition(input);
  validateEngineeringGraphRunOptions(definition, options);
  if (definition.managedWorktrees && options.persist === false) {
    throw new Error("Graph managedWorktrees require persistence");
  }
  let staticWorkspaces: Map<string, string> | undefined;
  if (definition.managedWorktrees) realpathSync.native(resolve(options.workspace));
  else staticWorkspaces = resolveNodeWorkspaces(options.workspace, definition);
  const effectiveCostBudget =
    options.costBudgetUsd === undefined
      ? definition.costBudgetUsd
      : Math.min(definition.costBudgetUsd ?? options.costBudgetUsd, options.costBudgetUsd);
  const effectiveTokenBudget =
    options.tokenBudget === undefined
      ? definition.tokenBudget
      : Math.min(definition.tokenBudget ?? options.tokenBudget, options.tokenBudget);
  const persistenceEnabled = options.persist !== false;
  const lease = persistenceEnabled
    ? await acquireSessionLeaseWithPreemption(options.workspace, `engineering-graph-${definition.graphId}`, {
        ...(options.signal ? { signal: options.signal } : {}),
      })
    : undefined;
  const runController = new AbortController();
  const detachParentAbort = onAbortOnce(options.signal, () => runController.abort(options.signal?.reason));
  let emergencyDrain: (() => Promise<void>) | undefined;
  let historyWriter: GraphLogWriter | undefined;
  let managedResourceLease: ReturnType<typeof acquireManagedOrchestrationWorktreeLease> | undefined;
  let managedWorktrees: Map<string, ManagedOrchestrationWorktree> | undefined;
  let durableCheckpointStarted = false;
  try {
    if (persistenceEnabled && !options.resume && !options.restart) {
      if (engineeringGraphStateExists(options.workspace, definition.graphId)) {
        throw new Error(`Persisted Graph already exists; use resume or restart: ${definition.graphId}`);
      }
    }
    if (definition.managedWorktrees) {
      managedResourceLease = acquireManagedOrchestrationWorktreeLease(options.workspace);
      const effectfulNodeIds = definition.nodes
        .filter((node) => node.kind !== "gate" && node.kind !== "router")
        .map((node) => node.id);
      const managedNodeIds = [...effectfulNodeIds, ...(definition.fanIn ? [ENGINEERING_GRAPH_FAN_IN_WORKTREE_ID] : [])];
      const expectedBranches = [...managedNodeIds].map(
        (nodeId) => `seekforge/${managedOrchestrationWorktreeSlug("graph", definition.graphId, nodeId)}`,
      );
      const existing = await listGitWorktrees(options.workspace);
      const existingManaged = existing.filter((entry) => entry.branch.startsWith("seekforge/")).length;
      const existingBranches = new Set(existing.map((entry) => entry.branch));
      if (options.restart && expectedBranches.some((branch) => existingBranches.has(branch))) {
        throw new Error(`Managed Graph resources must be pruned before restart: ${definition.graphId}`);
      }
      const missing = expectedBranches.filter((branch) => !existingBranches.has(branch)).length;
      if (existingManaged + missing > definition.managedWorktrees.limit) {
        throw new Error(
          `Graph managed worktree limit would be exceeded: ${existingManaged} existing + ${missing} required > ${definition.managedWorktrees.limit}`,
        );
      }
      managedWorktrees = await prepareManagedOrchestrationWorktrees(
        options.workspace,
        managedNodeIds,
        "graph",
        definition.graphId,
        options.resume === true,
      );
    }
    const workspaceOverrides = new Map(
      [...(managedWorktrees?.entries() ?? [])].map(([nodeId, managed]) => [nodeId, managed.path]),
    );
    const workspaces = staticWorkspaces ?? resolveNodeWorkspaces(options.workspace, definition, workspaceOverrides);
    const fingerprint = graphDefinitionFingerprint(definition, workspaces);
    const now = new Date().toISOString();
    let state: EngineeringGraphState = {
      schemaVersion: 1,
      graphId: definition.graphId,
      fingerprint,
      status: "running",
      definition,
      results: [],
      events: [],
      spentCost: 0,
      spentTokens: 0,
      createdAt: now,
      updatedAt: now,
      resourceGeneration: randomUUID(),
      ...(options.parentGraph ? { parentGraph: options.parentGraph } : {}),
    };
    if (options.resume) {
      const restored = loadEngineeringGraphState(options.workspace, definition.graphId);
      if (!restored) throw new Error(`Persisted Graph not found or invalid: ${definition.graphId}`);
      if (restored.fingerprint !== fingerprint)
        throw new Error(`Persisted Graph does not match: ${definition.graphId}`);
      if (
        restored.parentGraph?.graphId !== options.parentGraph?.graphId ||
        restored.parentGraph?.nodeId !== options.parentGraph?.nodeId
      ) {
        throw new Error(`Persisted Graph parent provenance does not match: ${definition.graphId}`);
      }
      state = { ...restored, status: "running", completedAt: undefined };
    }
    const results = new Map(state.results.map((result) => [result.id, result]));
    if (options.rerunFrom?.length) {
      const rootSelections = [...new Set(options.rerunFrom.map((id) => id.split("/", 1)[0]!))];
      const invalidated = orchestrationDescendantClosure(definition.nodes, rootSelections);
      for (const id of invalidated) results.delete(id);
      delete state.fanIn;
    }
    for (const [id, result] of results) {
      if (result.status === "waiting_approval" || (options.resume && result.error === "Graph cancelled")) {
        results.delete(id);
      }
    }
    state.spentCost =
      [...results.values()].reduce((sum, result) => sum + result.costUsd, 0) + (state.fanIn?.costUsd ?? 0);
    state.spentTokens =
      [...results.values()].reduce((sum, result) => sum + result.tokensUsed, 0) + (state.fanIn?.tokensUsed ?? 0);
    const byId = new Map(definition.nodes.map((node) => [node.id, node]));
    const pending = new Set(definition.nodes.map((node) => node.id).filter((id) => !results.has(id)));
    const inFlight = new Map<string, Promise<{ id: string; result: GraphNodeResult }>>();
    const costReservations = new Map<string, number>();
    const tokenReservations = new Map<string, number>();
    const resumedChildUsage = new Map<string, { costUsd: number; tokensUsed: number }>();
    if (persistenceEnabled && options.resume) {
      for (const node of definition.nodes) {
        if (node.kind !== "subgraph" || results.has(node.id) || options.rerunFrom?.includes(node.id)) continue;
        const childGraphId = engineeringSubgraphStateId(definition.graphId, node.id, node.graph!.graphId);
        const child = loadEngineeringGraphState(workspaces.get(node.id)!, childGraphId);
        if (!child) {
          throw new Error(`Persisted subgraph not found or invalid; rerun its parent node: ${childGraphId}`);
        }
        if (child.parentGraph?.graphId !== definition.graphId || child.parentGraph.nodeId !== node.id) {
          throw new Error(`Persisted Graph parent provenance does not match: ${childGraphId}`);
        }
        const nestedDefinition: EngineeringGraphDefinition = { ...node.graph!, graphId: childGraphId };
        const nestedWorkspaces = resolveNodeWorkspaces(workspaces.get(node.id)!, nestedDefinition);
        if (child.fingerprint !== graphDefinitionFingerprint(nestedDefinition, nestedWorkspaces)) {
          throw new Error(`Persisted Graph does not match: ${childGraphId}`);
        }
        resumedChildUsage.set(node.id, { costUsd: child.spentCost, tokensUsed: child.spentTokens });
      }
    }
    if (persistenceEnabled) {
      try {
        historyWriter = createEngineeringGraphLogWriter(options.workspace, definition.graphId);
      } catch {
        // History is observational and must not block the authoritative checkpoint.
      }
    }
    let budgetStopped = false;
    let nextSequence = state.events.at(-1)?.sequence ?? 0;
    const persist = (): void => {
      state = {
        ...state,
        results: definition.nodes.flatMap((node) => {
          const result = results.get(node.id);
          return result ? [result] : [];
        }),
        spentCost: [...results.values()].reduce((sum, result) => sum + result.costUsd, 0) + (state.fanIn?.costUsd ?? 0),
        spentTokens:
          [...results.values()].reduce((sum, result) => sum + result.tokensUsed, 0) + (state.fanIn?.tokensUsed ?? 0),
        updatedAt: new Date().toISOString(),
      };
      if (persistenceEnabled) saveEngineeringGraphState(options.workspace, state);
    };
    const emit = (event: Omit<GraphEvent, "sequence" | "timestamp">): void => {
      const complete: GraphEvent = {
        ...event,
        ...(event.message ? { message: event.message.slice(0, MAX_GRAPH_EVENT_MESSAGE_CHARS) } : {}),
        sequence: ++nextSequence,
        timestamp: new Date().toISOString(),
      };
      state.events = [...state.events, complete].slice(-MAX_GRAPH_EVENTS);
      try {
        historyWriter?.append(complete);
      } catch {
        // The atomic checkpoint remains authoritative when history I/O fails.
      }
      try {
        options.onEvent?.(complete);
      } catch (error) {
        const warning: GraphEvent = {
          sequence: ++nextSequence,
          timestamp: new Date().toISOString(),
          type: "graph.warning",
          message: `Graph observer failed: ${retryableError(error)}`.slice(0, MAX_GRAPH_EVENT_MESSAGE_CHARS),
        };
        state.events = [...state.events, warning].slice(-MAX_GRAPH_EVENTS);
        try {
          historyWriter?.append(warning);
        } catch {
          // The warning still belongs to the authoritative checkpoint.
        }
      }
      persist();
    };
    emit({ type: options.resume ? "graph.resumed" : "graph.started", status: "running" });
    durableCheckpointStarted = true;

    const completeWithoutRun = (node: GraphNode, status: "skipped" | "waiting_approval", message: string): void => {
      const timestamp = new Date().toISOString();
      const result: GraphNodeResult = {
        id: node.id,
        kind: node.kind,
        status,
        attempts: 0,
        costUsd: 0,
        tokensUsed: 0,
        completedAt: timestamp,
        ...(status === "skipped" ? { error: message } : {}),
      };
      results.set(node.id, result);
      pending.delete(node.id);
      emit({
        type: status === "skipped" ? "node.skipped" : "node.waiting_approval",
        nodeId: node.id,
        status,
        message,
      });
    };

    const cancelWaitingResults = (): void => {
      const waiting = [...results].filter(([, result]) => result.status === "waiting_approval");
      for (let index = 0; index < waiting.length; index++) {
        const [id, result] = waiting[index]!;
        if (index === waiting.length - 1) state.status = "running";
        const { output: _waitingOutput, ...retained } = result;
        results.set(id, {
          ...retained,
          status: "skipped",
          attempts: 0,
          error: "Graph cancelled",
        });
        emit({ type: "node.skipped", nodeId: id, status: "skipped", message: "Graph cancelled" });
      }
    };

    const startNode = (node: GraphNode, costShare?: number, tokenShare?: number): void => {
      pending.delete(node.id);
      const startedAt = new Date().toISOString();
      emit({ type: "node.started", nodeId: node.id });
      const resumedUsage = resumedChildUsage.get(node.id);
      resumedChildUsage.delete(node.id);
      const baseCost = resumedUsage?.costUsd ?? 0;
      const baseTokens = resumedUsage?.tokensUsed ?? 0;
      if (costShare !== undefined || resumedUsage?.costUsd) {
        costReservations.set(node.id, (costShare ?? 0) + (resumedUsage?.costUsd ?? 0));
      }
      if (tokenShare !== undefined || resumedUsage?.tokensUsed) {
        tokenReservations.set(node.id, (tokenShare ?? 0) + (resumedUsage?.tokensUsed ?? 0));
      }
      const dependencySnapshot = new Map(
        (node.dependsOn ?? []).map((dependency) => [dependency, results.get(dependency)!]),
      );
      const promise = (async (): Promise<{ id: string; result: GraphNodeResult }> => {
        const managed = managedWorktrees?.get(node.id);
        let attempts = 0;
        let lastError = "Graph node failed";
        let consumedCost = 0;
        let consumedTokens = 0;
        let failedSessionId: string | undefined;
        while (attempts <= (node.maxRetries ?? 0)) {
          const attemptCostBudget = costShare === undefined ? undefined : costShare - consumedCost;
          const attemptTokenBudget = tokenShare === undefined ? undefined : tokenShare - consumedTokens;
          if (
            (attemptCostBudget !== undefined && attemptCostBudget <= 0) ||
            (attemptTokenBudget !== undefined && attemptTokenBudget <= 0)
          ) {
            lastError = "Graph node retry budget exhausted";
            break;
          }
          attempts++;
          try {
            if (attempts === 1 && managed && definition.managedWorktrees?.integrateDependencies) {
              const sourceIds = new Set<string>();
              const collectSources = (dependency: string): void => {
                if (results.get(dependency)?.status !== "passed") return;
                if (managedWorktrees?.has(dependency)) {
                  sourceIds.add(dependency);
                  return;
                }
                for (const ancestor of byId.get(dependency)?.dependsOn ?? []) collectSources(ancestor);
              };
              for (const dependency of node.dependsOn ?? []) collectSources(dependency);
              for (const dependency of sourceIds) {
                const source = managedWorktrees!.get(dependency)!;
                const merged = await mergeWorktree(managed.path, source.path, source.branch);
                if ("conflict" in merged) {
                  throw new GraphNodeNonRetryableError(
                    `Dependency integration conflict from ${dependency}: ${merged.files.slice(0, 32).join(", ")}`,
                  );
                }
              }
            }
            const execution = await withTimeout(
              (signal) =>
                executeNode(
                  deps,
                  definition.graphId,
                  node,
                  workspaces.get(node.id)!,
                  dependencySnapshot,
                  options,
                  attemptCostBudget,
                  attemptTokenBudget,
                  signal,
                  attempts,
                ),
              node.timeoutMs,
              runController.signal,
            );
            if (managed) {
              try {
                await checkpointWorktree(managed.path, `chore: checkpoint Graph node ${node.id}`);
              } catch (error) {
                throw new GraphNodeNonRetryableError(`Graph node checkpoint failed: ${retryableError(error)}`, {
                  costUsd: execution.costUsd,
                  tokensUsed: execution.tokensUsed,
                  ...(execution.sessionId ? { sessionId: execution.sessionId } : {}),
                });
              }
            }
            return {
              id: node.id,
              result: {
                id: node.id,
                kind: node.kind,
                status: "passed",
                attempts,
                startedAt,
                completedAt: new Date().toISOString(),
                costUsd: baseCost + consumedCost + execution.costUsd,
                tokensUsed: baseTokens + consumedTokens + execution.tokensUsed,
                ...(execution.sessionId ? { sessionId: execution.sessionId } : {}),
                ...(execution.output !== undefined ? { output: execution.output } : {}),
                ...(managed ? { managedBranch: managed.branch } : {}),
              },
            };
          } catch (error) {
            lastError = retryableError(error);
            if (error instanceof GraphSubgraphPausedError) {
              return {
                id: node.id,
                result: {
                  id: node.id,
                  kind: node.kind,
                  status: "waiting_approval",
                  attempts,
                  startedAt,
                  completedAt: new Date().toISOString(),
                  costUsd: baseCost + consumedCost + error.usage.costUsd,
                  tokensUsed: baseTokens + consumedTokens + error.usage.tokensUsed,
                  output: boundedOutput({ childGraphId: error.childGraphId, waitingFor: error.waitingFor }),
                },
              };
            }
            if (error instanceof GraphNodeExecutionError) {
              consumedCost += error.usage.costUsd;
              consumedTokens += error.usage.tokensUsed;
              failedSessionId = error.usage.sessionId;
            } else if (error instanceof GraphNodeNonRetryableError && error.usage) {
              consumedCost += error.usage.costUsd;
              consumedTokens += error.usage.tokensUsed;
              failedSessionId = error.usage.sessionId;
            }
            if (runController.signal.aborted) {
              lastError = "Graph cancelled";
              break;
            }
            if (error instanceof GraphNodeNonRetryableError) break;
          }
        }
        return {
          id: node.id,
          result: {
            id: node.id,
            kind: node.kind,
            status: "failed",
            attempts,
            startedAt,
            completedAt: new Date().toISOString(),
            costUsd: baseCost + consumedCost,
            tokensUsed: baseTokens + consumedTokens,
            ...(failedSessionId ? { sessionId: failedSessionId } : {}),
            error: lastError,
          },
        };
      })();
      inFlight.set(node.id, promise);
    };

    const recordCompleted = (completed: { id: string; result: GraphNodeResult }): void => {
      inFlight.delete(completed.id);
      costReservations.delete(completed.id);
      tokenReservations.delete(completed.id);
      const result =
        completed.result.output === undefined
          ? completed.result
          : { ...completed.result, output: fitOutputBudget(completed.result.output, results) };
      results.set(completed.id, result);
      if (result.status === "waiting_approval") state.status = "paused";
      emit({
        type: result.status === "waiting_approval" ? "node.waiting_approval" : "node.completed",
        nodeId: completed.id,
        status: result.status,
        ...(result.error ? { message: result.error } : {}),
      });
    };

    const settleInFlight = async (): Promise<void> => {
      while (inFlight.size) recordCompleted(await Promise.race(inFlight.values()));
    };
    emergencyDrain = async () => {
      runController.abort(new Error("Graph scheduler stopped"));
      while (inFlight.size) {
        const completed = await Promise.race(inFlight.values());
        try {
          recordCompleted(completed);
        } catch {
          inFlight.delete(completed.id);
          costReservations.delete(completed.id);
          tokenReservations.delete(completed.id);
          if (!results.has(completed.id)) {
            const result =
              completed.result.output === undefined
                ? completed.result
                : { ...completed.result, output: fitOutputBudget(completed.result.output, results) };
            results.set(completed.id, result);
          }
        }
      }
    };

    while (
      pending.size ||
      inFlight.size ||
      [...results.values()].some((result) => result.status === "waiting_approval")
    ) {
      if (runController.signal.aborted) {
        await settleInFlight();
        cancelWaitingResults();
        for (const id of [...pending]) completeWithoutRun(byId.get(id)!, "skipped", "Graph cancelled");
        state.status = "cancelled";
        state.completedAt = new Date().toISOString();
        emit({ type: "graph.completed", status: "cancelled", message: "Graph cancelled" });
        return state;
      }
      const waiting = [...results.values()].find((result) => result.status === "waiting_approval");
      if (waiting) {
        await settleInFlight();
        if (runController.signal.aborted) continue;
        const settledWaiting = [...results.values()].find((result) => result.status === "waiting_approval")!;
        state.status = "paused";
        emit({
          type: "graph.paused",
          status: "paused",
          nodeId: settledWaiting.id,
          message: `Subgraph node ${settledWaiting.id} is waiting for approval`,
        });
        return state;
      }
      if (definition.failurePolicy === "stop" && [...results.values()].some((result) => result.status === "failed")) {
        for (const id of [...pending])
          completeWithoutRun(byId.get(id)!, "skipped", "Graph stopped after a node failure");
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const id of [...pending]) {
          const node = byId.get(id)!;
          const dependencies = (node.dependsOn ?? []).map((dependency) => results.get(dependency));
          if (dependencies.some((result) => result === undefined)) continue;
          if (node.route) {
            const router = results.get(node.route.routerId);
            const branch =
              router?.output && typeof router.output === "object" && "branch" in router.output
                ? (router.output as { branch?: unknown }).branch
                : undefined;
            if (router?.status !== "passed" || branch !== node.route.branch) {
              completeWithoutRun(node, "skipped", `Router ${node.route.routerId} selected another branch`);
              changed = true;
              continue;
            }
          }
          if (node.condition && !graphConditionMatches(node.condition, results)) {
            completeWithoutRun(node, "skipped", "Graph condition did not match");
            changed = true;
            continue;
          }
          if (!node.condition && dependencies.some((result) => result?.status !== "passed")) {
            completeWithoutRun(node, "skipped", "A dependency did not pass");
            changed = true;
            continue;
          }
          if (node.kind === "gate") {
            let approved = options.approvedNodeIds?.includes(node.id) === true;
            if (!approved && options.approveNode) {
              approved = (await options.approveNode(node, new Map(results), definition.graphId)) === true;
            }
            if (!approved) {
              state.status = "paused";
              completeWithoutRun(node, "waiting_approval", "Explicit approval is required");
              await settleInFlight();
              if (runController.signal.aborted) {
                cancelWaitingResults();
                for (const id of [...pending]) completeWithoutRun(byId.get(id)!, "skipped", "Graph cancelled");
                state.status = "cancelled";
                state.completedAt = new Date().toISOString();
                emit({ type: "graph.completed", status: "cancelled", message: "Graph cancelled" });
                return state;
              }
              emit({ type: "graph.paused", status: "paused", nodeId: node.id });
              return state;
            }
            const timestamp = new Date().toISOString();
            results.set(node.id, {
              id: node.id,
              kind: node.kind,
              status: "passed",
              attempts: 0,
              costUsd: 0,
              tokensUsed: 0,
              startedAt: timestamp,
              completedAt: timestamp,
              output: { approved: true },
            });
            pending.delete(node.id);
            emit({ type: "node.completed", nodeId: node.id, status: "passed", message: "Gate approved" });
            changed = true;
          }
        }
      }
      const budgetExhausted =
        inFlight.size === 0 &&
        ((effectiveCostBudget !== undefined &&
          state.spentCost + [...resumedChildUsage.values()].reduce((sum, usage) => sum + usage.costUsd, 0) >=
            effectiveCostBudget) ||
          (effectiveTokenBudget !== undefined &&
            state.spentTokens + [...resumedChildUsage.values()].reduce((sum, usage) => sum + usage.tokensUsed, 0) >=
              effectiveTokenBudget));
      if (budgetExhausted) {
        budgetStopped = pending.size > 0;
        for (const id of [...pending]) completeWithoutRun(byId.get(id)!, "skipped", "Graph budget exhausted");
      }
      const availableSlots = (definition.maxConcurrency ?? 1) - inFlight.size;
      const readyNodes = [...pending]
        .map((id) => byId.get(id)!)
        .filter((node) => (node.dependsOn ?? []).every((dependency) => results.has(dependency)));
      const reservedCost =
        [...costReservations.values()].reduce((sum, value) => sum + value, 0) +
        [...resumedChildUsage.values()].reduce((sum, usage) => sum + usage.costUsd, 0);
      const reservedTokens =
        [...tokenReservations.values()].reduce((sum, value) => sum + value, 0) +
        [...resumedChildUsage.values()].reduce((sum, usage) => sum + usage.tokensUsed, 0);
      const remainingCost =
        effectiveCostBudget === undefined
          ? undefined
          : Math.max(0, effectiveCostBudget - state.spentCost - reservedCost);
      const remainingTokens =
        effectiveTokenBudget === undefined
          ? undefined
          : Math.max(0, effectiveTokenBudget - state.spentTokens - reservedTokens);
      let launchCount = Math.min(availableSlots, readyNodes.length);
      if (remainingCost === 0 || remainingTokens === 0) launchCount = 0;
      if (remainingTokens !== undefined) launchCount = Math.min(launchCount, Math.floor(remainingTokens));
      const costShare = remainingCost === undefined || launchCount === 0 ? undefined : remainingCost / launchCount;
      const tokenShare =
        remainingTokens === undefined || launchCount === 0
          ? undefined
          : Math.max(1, Math.floor(remainingTokens / launchCount));
      for (const node of readyNodes.slice(0, launchCount)) {
        startNode(node, costShare, tokenShare);
      }
      if (!inFlight.size) {
        if (pending.size) throw new Error("Graph scheduler made no progress");
        break;
      }
      recordCompleted(await Promise.race(inFlight.values()));
    }
    if (runController.signal.aborted) {
      state.status = "cancelled";
      state.completedAt = new Date().toISOString();
      emit({ type: "graph.completed", status: "cancelled", message: "Graph cancelled" });
      return state;
    }
    const exceededBudget =
      (effectiveCostBudget !== undefined && state.spentCost > effectiveCostBudget) ||
      (effectiveTokenBudget !== undefined && state.spentTokens > effectiveTokenBudget);
    const hasBudgetSkip = [...results.values()].some(
      (result) => result.status === "skipped" && result.error === "Graph budget exhausted",
    );
    state.status =
      budgetStopped ||
      hasBudgetSkip ||
      exceededBudget ||
      [...results.values()].some((result) => result.status === "failed")
        ? "failed"
        : "passed";
    if (state.status === "passed" && definition.fanIn && state.fanIn?.status !== "passed") {
      const integration = managedWorktrees?.get(ENGINEERING_GRAPH_FAN_IN_WORKTREE_ID);
      if (!integration) throw new Error("Graph fan-in integration worktree is unavailable");
      const retainedCost = state.fanIn?.costUsd ?? 0;
      const retainedTokens = state.fanIn?.tokensUsed ?? 0;
      let costUsd = retainedCost;
      let tokensUsed = retainedTokens;
      let error: string | undefined;
      state.status = "running";
      emit({ type: "fan_in.started", status: "running" });
      try {
        if (runController.signal.aborted) throw new Error("Graph cancelled");
        if (!integration.created) {
          await checkpointWorktree(integration.path, "chore: checkpoint prior Engineering Graph integration attempt");
        }
        for (const node of definition.nodes) {
          if (runController.signal.aborted) throw new Error("Graph cancelled");
          const result = results.get(node.id);
          const source = managedWorktrees?.get(node.id);
          if (result?.status !== "passed" || !source) continue;
          if (result.managedBranch !== source.branch) {
            throw new Error(`Graph node ${node.id} managed branch provenance does not match`);
          }
          const merged = await mergeWorktree(integration.path, source.path, source.branch);
          if ("conflict" in merged) {
            throw new Error(`Graph fan-in conflict from ${node.id}: ${merged.files.slice(0, 32).join(", ")}`);
          }
        }
        const remainingCost =
          effectiveCostBudget === undefined ? undefined : Math.max(0, effectiveCostBudget - state.spentCost);
        const remainingTokens =
          effectiveTokenBudget === undefined ? undefined : Math.max(0, effectiveTokenBudget - state.spentTokens);
        if (
          (remainingCost !== undefined && remainingCost <= 0) ||
          (remainingTokens !== undefined && remainingTokens <= 0)
        ) {
          throw new Error("Graph budget exhausted before fan-in verification");
        }
        const loop = await runAutoLoop(deps, {
          task: "Verify and, if necessary, repair the combined Engineering Graph integration without weakening its gate.",
          workspace: integration.path,
          verifyCommand: definition.fanIn.verifyCommand,
          maxIterations: definition.fanIn.maxIterations,
          maxNoProgressRecoveries: 0,
          approvalMode: "acceptEdits",
          persist: false,
          ...(remainingCost !== undefined ? { costBudgetUsd: remainingCost } : {}),
          ...(remainingTokens !== undefined ? { tokenBudget: remainingTokens } : {}),
          signal: runController.signal,
        });
        costUsd += loop.costUsd;
        tokensUsed += loop.tokensUsed ?? 0;
        if (loop.status !== "passed") throw new Error(`Graph fan-in verification ended with ${loop.status}`);
        await checkpointWorktree(integration.path, "chore: checkpoint Engineering Graph integration");
      } catch (caught) {
        error = retryableError(caught).slice(0, 8_192) || "Graph fan-in failed";
      }
      state.fanIn = {
        status: error ? "failed" : "passed",
        workspace: integration.path,
        branch: integration.branch,
        costUsd,
        tokensUsed,
        updatedAt: new Date().toISOString(),
        ...(error ? { error } : {}),
      };
      const fanInStatus = runController.signal.aborted ? "cancelled" : error ? "failed" : "passed";
      emit({
        type: "fan_in.completed",
        status: fanInStatus,
        ...(error ? { message: error } : {}),
      });
      state.status = fanInStatus;
    }
    state.completedAt = new Date().toISOString();
    emit({ type: "graph.completed", status: state.status });
    return state;
  } finally {
    try {
      await emergencyDrain?.();
    } finally {
      try {
        historyWriter?.close();
      } catch {
        // The atomic checkpoint remains authoritative when history I/O fails.
      }
      detachParentAbort();
      if (!durableCheckpointStarted && managedWorktrees) {
        for (const managed of [...managedWorktrees.values()].reverse()) {
          if (managed.created) {
            await removeWorktree(options.workspace, managed.path, managed.branch).catch(() => undefined);
          }
        }
      }
      managedResourceLease?.release();
      lease?.release();
    }
  }
}
