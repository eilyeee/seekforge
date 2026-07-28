import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { onAbortOnce } from "../util/abort.js";
import type { AgentCoreDeps } from "./loop.js";
import { runAutoLoop } from "./auto-loop.js";
import { createAgentCore } from "./loop.js";
import {
  type EngineeringGraphDefinition,
  type GraphNode,
  graphConditionMatches,
  graphDefinitionFingerprint,
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
  loadEngineeringGraphState,
  saveEngineeringGraphState,
} from "./graph-state.js";
import { acquireSessionLeaseWithPreemption } from "./session-lease.js";

const MAX_GRAPH_OUTPUT_BYTES = 16 * 1024;
const MAX_GRAPH_OUTPUT_TOTAL_BYTES = 128 * 1024;

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
  const validateSelection = (value: unknown, name: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_GRAPH_NODES) {
      throw new Error(`Graph ${name} must be a bounded array`);
    }
    const selected: string[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index) || typeof value[index] !== "string") {
        throw new Error(`Graph ${name} must contain node ids`);
      }
      selected.push(value[index]);
    }
    if (new Set(selected).size !== selected.length) throw new Error(`Graph ${name} contains duplicate node ids`);
    return selected;
  };
  const rerunFrom = validateSelection(options.rerunFrom, "rerunFrom");
  const approvedNodeIds = validateSelection(options.approvedNodeIds, "approvedNodeIds");
  if (rerunFrom.length && !options.resume) throw new Error("Graph rerunFrom requires resume");
  const declaredNodes = new Set(definition.nodes.map((node) => node.id));
  for (const id of rerunFrom) {
    if (!declaredNodes.has(id)) throw new Error(`Unknown Graph rerun node: ${id}`);
  }
  const gateIds = new Set(definition.nodes.filter((node) => node.kind === "gate").map((node) => node.id));
  for (const id of approvedNodeIds) {
    if (!gateIds.has(id)) throw new Error(`Unknown Graph gate approval: ${id}`);
  }
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
  resolveNodeWorkspaces(workspace, definition);
}

function resolveNodeWorkspaces(rootInput: string, definition: EngineeringGraphDefinition): Map<string, string> {
  const root = realpathSync.native(resolve(rootInput));
  const workspaces = new Map<string, string>();
  const visit = (graph: EngineeringGraphDefinition, graphRoot: string, prefix: string): void => {
    for (const node of graph.nodes) {
      const key = `${prefix}${node.id}`;
      const requested = node.workspace
        ? isAbsolute(node.workspace)
          ? node.workspace
          : resolve(graphRoot, node.workspace)
        : graphRoot;
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
      const effectful = graph.nodes
        .filter((node) => node.kind !== "router" && node.kind !== "gate")
        .map((node) => workspaces.get(`${prefix}${node.id}`)!);
      for (let leftIndex = 0; leftIndex < effectful.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < effectful.length; rightIndex++) {
          const left = effectful[leftIndex]!;
          const right = effectful[rightIndex]!;
          const leftToRight = relative(left, right);
          const rightToLeft = relative(right, left);
          if (
            left === right ||
            (!leftToRight.startsWith(`..${sep}`) && leftToRight !== ".." && !isAbsolute(leftToRight)) ||
            (!rightToLeft.startsWith(`..${sep}`) && rightToLeft !== ".." && !isAbsolute(rightToLeft))
          ) {
            throw new Error("Concurrent effectful Graph nodes must use non-overlapping physical workspaces");
          }
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
  node: GraphNode,
  workspace: string,
  completed: ReadonlyMap<string, GraphNodeResult>,
  options: RunEngineeringGraphOptions,
  costBudgetUsd: number | undefined,
  tokenBudget: number | undefined,
  signal: AbortSignal,
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
    const nestedDefinition: EngineeringGraphDefinition = {
      ...node.graph!,
      ...(costBudgetUsd !== undefined
        ? { costBudgetUsd: Math.min(node.graph!.costBudgetUsd ?? costBudgetUsd, costBudgetUsd) }
        : {}),
      ...(tokenBudget !== undefined
        ? { tokenBudget: Math.min(node.graph!.tokenBudget ?? tokenBudget, tokenBudget) }
        : {}),
    };
    const nested = await runEngineeringGraph(deps, nestedDefinition, {
      ...options,
      workspace,
      persist: false,
      resume: false,
      rerunFrom: undefined,
      approvedNodeIds: options.approvedNodeIds?.flatMap((id) =>
        id.startsWith(`${node.id}/`) ? [id.slice(node.id.length + 1)] : [],
      ),
      onEvent: undefined,
      signal,
    });
    if (nested.status !== "passed") {
      throw new GraphNodeExecutionError(`Subgraph ${node.graph!.graphId} finished with status ${nested.status}`, {
        costUsd: nested.spentCost,
        tokensUsed: nested.spentTokens,
      });
    }
    return {
      costUsd: nested.spentCost,
      tokensUsed: nested.spentTokens,
      output: boundedOutput({
        graphId: nested.graphId,
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
  const workspaces = resolveNodeWorkspaces(options.workspace, definition);
  const fingerprint = graphDefinitionFingerprint(definition, workspaces);
  const persistenceEnabled = options.persist !== false;
  const lease = persistenceEnabled
    ? await acquireSessionLeaseWithPreemption(options.workspace, `engineering-graph-${definition.graphId}`, {
        ...(options.signal ? { signal: options.signal } : {}),
      })
    : undefined;
  const runController = new AbortController();
  const detachParentAbort = onAbortOnce(options.signal, () => runController.abort(options.signal?.reason));
  let emergencyDrain: (() => Promise<void>) | undefined;
  try {
    if (persistenceEnabled && !options.resume && !options.restart) {
      if (engineeringGraphStateExists(options.workspace, definition.graphId)) {
        throw new Error(`Persisted Graph already exists; use resume or restart: ${definition.graphId}`);
      }
    }
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
    };
    if (options.resume) {
      const restored = loadEngineeringGraphState(options.workspace, definition.graphId);
      if (!restored) throw new Error(`Persisted Graph not found or invalid: ${definition.graphId}`);
      if (restored.fingerprint !== fingerprint)
        throw new Error(`Persisted Graph does not match: ${definition.graphId}`);
      state = { ...restored, status: "running", completedAt: undefined };
    }
    const results = new Map(state.results.map((result) => [result.id, result]));
    if (options.rerunFrom?.length) {
      const invalidated = new Set(options.rerunFrom);
      let changed = true;
      while (changed) {
        changed = false;
        for (const node of definition.nodes) {
          if (!invalidated.has(node.id) && (node.dependsOn ?? []).some((id) => invalidated.has(id))) {
            invalidated.add(node.id);
            changed = true;
          }
        }
      }
      for (const id of invalidated) results.delete(id);
    }
    for (const [id, result] of results) {
      if (result.status === "waiting_approval" || (options.resume && result.error === "Graph cancelled")) {
        results.delete(id);
      }
    }
    state.spentCost = [...results.values()].reduce((sum, result) => sum + result.costUsd, 0);
    state.spentTokens = [...results.values()].reduce((sum, result) => sum + result.tokensUsed, 0);
    const byId = new Map(definition.nodes.map((node) => [node.id, node]));
    const pending = new Set(definition.nodes.map((node) => node.id).filter((id) => !results.has(id)));
    const inFlight = new Map<string, Promise<{ id: string; result: GraphNodeResult }>>();
    const costReservations = new Map<string, number>();
    const tokenReservations = new Map<string, number>();
    let budgetStopped = false;
    let nextSequence = state.events.at(-1)?.sequence ?? 0;
    const persist = (): void => {
      state = {
        ...state,
        results: definition.nodes.flatMap((node) => {
          const result = results.get(node.id);
          return result ? [result] : [];
        }),
        spentCost: [...results.values()].reduce((sum, result) => sum + result.costUsd, 0),
        spentTokens: [...results.values()].reduce((sum, result) => sum + result.tokensUsed, 0),
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
        options.onEvent?.(complete);
      } catch (error) {
        const warning: GraphEvent = {
          sequence: ++nextSequence,
          timestamp: new Date().toISOString(),
          type: "graph.warning",
          message: `Graph observer failed: ${retryableError(error)}`.slice(0, MAX_GRAPH_EVENT_MESSAGE_CHARS),
        };
        state.events = [...state.events, warning].slice(-MAX_GRAPH_EVENTS);
      }
      persist();
    };
    emit({ type: options.resume ? "graph.resumed" : "graph.started", status: "running" });

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

    const startNode = (node: GraphNode, costShare?: number, tokenShare?: number): void => {
      pending.delete(node.id);
      const startedAt = new Date().toISOString();
      emit({ type: "node.started", nodeId: node.id });
      if (costShare !== undefined) costReservations.set(node.id, costShare);
      if (tokenShare !== undefined) tokenReservations.set(node.id, tokenShare);
      const dependencySnapshot = new Map(
        (node.dependsOn ?? []).map((dependency) => [dependency, results.get(dependency)!]),
      );
      const promise = (async (): Promise<{ id: string; result: GraphNodeResult }> => {
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
            const execution = await withTimeout(
              (signal) =>
                executeNode(
                  deps,
                  node,
                  workspaces.get(node.id)!,
                  dependencySnapshot,
                  options,
                  attemptCostBudget,
                  attemptTokenBudget,
                  signal,
                ),
              node.timeoutMs,
              runController.signal,
            );
            return {
              id: node.id,
              result: {
                id: node.id,
                kind: node.kind,
                status: "passed",
                attempts,
                startedAt,
                completedAt: new Date().toISOString(),
                costUsd: consumedCost + execution.costUsd,
                tokensUsed: consumedTokens + execution.tokensUsed,
                ...(execution.sessionId ? { sessionId: execution.sessionId } : {}),
                ...(execution.output !== undefined ? { output: execution.output } : {}),
              },
            };
          } catch (error) {
            lastError = retryableError(error);
            if (error instanceof GraphNodeExecutionError) {
              consumedCost += error.usage.costUsd;
              consumedTokens += error.usage.tokensUsed;
              failedSessionId = error.usage.sessionId;
            }
            if (runController.signal.aborted) {
              lastError = "Graph cancelled";
              break;
            }
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
            costUsd: consumedCost,
            tokensUsed: consumedTokens,
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
      emit({
        type: "node.completed",
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

    while (pending.size || inFlight.size) {
      if (runController.signal.aborted) {
        await settleInFlight();
        state.status = "cancelled";
        state.completedAt = new Date().toISOString();
        for (const id of [...pending]) completeWithoutRun(byId.get(id)!, "skipped", "Graph cancelled");
        emit({ type: "graph.completed", status: "cancelled", message: "Graph cancelled" });
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
                state.status = "cancelled";
                state.completedAt = new Date().toISOString();
                completeWithoutRun(node, "skipped", "Graph cancelled");
                for (const id of [...pending]) completeWithoutRun(byId.get(id)!, "skipped", "Graph cancelled");
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
        ((definition.costBudgetUsd !== undefined && state.spentCost >= definition.costBudgetUsd) ||
          (definition.tokenBudget !== undefined && state.spentTokens >= definition.tokenBudget));
      if (budgetExhausted) {
        budgetStopped = pending.size > 0;
        for (const id of [...pending]) completeWithoutRun(byId.get(id)!, "skipped", "Graph budget exhausted");
      }
      const availableSlots = (definition.maxConcurrency ?? 1) - inFlight.size;
      const readyNodes = [...pending]
        .map((id) => byId.get(id)!)
        .filter((node) => (node.dependsOn ?? []).every((dependency) => results.has(dependency)));
      const reservedCost = [...costReservations.values()].reduce((sum, value) => sum + value, 0);
      const reservedTokens = [...tokenReservations.values()].reduce((sum, value) => sum + value, 0);
      const remainingCost =
        definition.costBudgetUsd === undefined
          ? undefined
          : Math.max(0, definition.costBudgetUsd - state.spentCost - reservedCost);
      const remainingTokens =
        definition.tokenBudget === undefined
          ? undefined
          : Math.max(0, definition.tokenBudget - state.spentTokens - reservedTokens);
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
      (definition.costBudgetUsd !== undefined && state.spentCost > definition.costBudgetUsd) ||
      (definition.tokenBudget !== undefined && state.spentTokens > definition.tokenBudget);
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
    state.completedAt = new Date().toISOString();
    emit({ type: "graph.completed", status: state.status });
    return state;
  } finally {
    try {
      await emergencyDrain?.();
    } finally {
      detachParentAbort();
      lease?.release();
    }
  }
}
