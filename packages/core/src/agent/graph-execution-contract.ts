import { isRecord } from "../util/guards.js";
import type { LoopOptions } from "./auto-loop.js";
import type { GraphNode } from "./graph-contract.js";
import type { GraphEvent, GraphNodeResult } from "./graph-state.js";
import type { SessionLease } from "./session-lease.js";
import { isDenseArray } from "./orchestration.js";

/**
 * The contract between the Graph runtime and everything it dispatches to:
 * in-process handlers, remote executors, and the run options that supply them.
 * It lives apart from the runtime so advisory surfaces (planning, reporting,
 * optimization) can judge an executor without importing the executor loop.
 */
export type GraphFunctionContext = {
  node: GraphNode;
  workspace: string;
  dependencies: ReadonlyMap<string, GraphNodeResult>;
  inputs: Readonly<Record<string, unknown>>;
  /** Stable for one logical attempt, so effectful handlers can deduplicate retries. */
  idempotencyKey: string;
  item?: unknown;
  itemIndex?: number;
  costBudgetUsd?: number;
  tokenBudget?: number;
  signal: AbortSignal;
  executorLease?: { fencingToken: string; expiresAt?: string };
};

export type GraphFunctionResult = {
  output?: unknown;
  costUsd?: number;
  tokensUsed?: number;
  artifacts?: Array<{ name: string; path: string; sha256?: string }>;
};
export type GraphFunctionHandler = (
  context: GraphFunctionContext,
) => GraphFunctionResult | Promise<GraphFunctionResult>;

/** The Loop verify implementation a `loop` node binds by id. */
export type GraphLoopVerifier = NonNullable<LoopOptions["verify"]>;

export type GraphExecutionAdapter = {
  /** Untrusted adapters are rejected during preflight, before any node starts. */
  trusted: boolean;
  locality: "remote";
  protocolVersion?: 1;
  supportsCancellation?: boolean;
  /** Scheduler-facing health and bounded load snapshot supplied by the trusted host. */
  healthy?: boolean;
  capacity?: number;
  active?: number;
  queueDepth?: number;
  /** Opt-in capacity shared by all Graphs in this workspace, enforced cross-process. */
  workspaceCapacity?: number;
  region?: string;
  dataLocality?: string[];
  /** Reserves remote capacity and returns a fencing token for this exact attempt. */
  reserve?: (
    context: GraphFunctionContext,
  ) =>
    | { fencingToken: string; expiresAt?: string; release: () => void | Promise<void> }
    | Promise<{ fencingToken: string; expiresAt?: string; release: () => void | Promise<void> }>;
  /** Recovers a previously committed result for this stable idempotency key. */
  recover?: (
    context: GraphFunctionContext,
  ) => GraphFunctionResult | undefined | Promise<GraphFunctionResult | undefined>;
  /** Optional liveness probe. Failures during execution are advisory. */
  heartbeat?: (context: GraphFunctionContext) => void | Promise<void>;
  heartbeatIntervalMs?: number;
  /** Cooperative cancellation notification for an already-dispatched attempt. */
  cancel?: (context: GraphFunctionContext) => void | Promise<void>;
  /** Verifies executor-owned provenance before the result becomes authoritative. */
  verifyResult?: (result: GraphFunctionResult, context: GraphFunctionContext) => boolean | Promise<boolean>;
  execute: GraphFunctionHandler;
};

export type GraphExecutionAdapterEligibility = {
  status:
    | "eligible"
    | "missing"
    | "untrusted"
    | "protocol_mismatch"
    | "cancellation_unsupported"
    | "unhealthy"
    | "capacity_exhausted"
    | "invalid";
  reasons: string[];
};

/** Owns runtime and advisory executor eligibility so both surfaces fail closed identically. */
export function graphExecutionAdapterEligibility(
  node: GraphNode,
  adapter: GraphExecutionAdapter | undefined,
): GraphExecutionAdapterEligibility {
  if (!adapter) return { status: "missing", reasons: ["Executor is not registered"] };
  if (adapter.trusted !== true) return { status: "untrusted", reasons: ["Executor is not trusted"] };
  if (
    adapter.locality !== "remote" ||
    typeof adapter.execute !== "function" ||
    (adapter.healthy !== undefined && typeof adapter.healthy !== "boolean") ||
    (adapter.capacity !== undefined &&
      (!Number.isSafeInteger(adapter.capacity) || adapter.capacity < 1 || adapter.capacity > 1_024)) ||
    (adapter.active !== undefined &&
      (!Number.isSafeInteger(adapter.active) || adapter.active < 0 || adapter.active > (adapter.capacity ?? 1_024))) ||
    (adapter.queueDepth !== undefined &&
      (!Number.isSafeInteger(adapter.queueDepth) || adapter.queueDepth < 0 || adapter.queueDepth > 1_000_000)) ||
    (adapter.workspaceCapacity !== undefined &&
      (!Number.isSafeInteger(adapter.workspaceCapacity) ||
        adapter.workspaceCapacity < 1 ||
        adapter.workspaceCapacity > 512)) ||
    (adapter.region !== undefined &&
      (typeof adapter.region !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(adapter.region))) ||
    (adapter.dataLocality !== undefined &&
      (!isDenseArray(adapter.dataLocality) ||
        adapter.dataLocality.length > 32 ||
        new Set(adapter.dataLocality).size !== adapter.dataLocality.length ||
        adapter.dataLocality.some(
          (item) => typeof item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(item),
        ))) ||
    (adapter.reserve !== undefined && typeof adapter.reserve !== "function") ||
    (adapter.recover !== undefined && typeof adapter.recover !== "function") ||
    (adapter.heartbeat !== undefined && typeof adapter.heartbeat !== "function") ||
    (adapter.cancel !== undefined && typeof adapter.cancel !== "function") ||
    (adapter.verifyResult !== undefined && typeof adapter.verifyResult !== "function") ||
    (adapter.heartbeatIntervalMs !== undefined &&
      (!Number.isSafeInteger(adapter.heartbeatIntervalMs) ||
        adapter.heartbeatIntervalMs < 1_000 ||
        adapter.heartbeatIntervalMs > 60_000))
  ) {
    return { status: "invalid", reasons: ["Executor contract is invalid"] };
  }
  if ((node.executorProtocolVersion ?? 1) !== (adapter.protocolVersion ?? 1)) {
    return { status: "protocol_mismatch", reasons: ["Protocol version does not match"] };
  }
  if (node.requiresCancellation && !adapter.supportsCancellation) {
    return { status: "cancellation_unsupported", reasons: ["Cancellation is required"] };
  }
  if (adapter.healthy === false) return { status: "unhealthy", reasons: ["Executor reports unhealthy"] };
  if (adapter.capacity !== undefined && (adapter.active ?? 0) >= adapter.capacity) {
    return { status: "capacity_exhausted", reasons: ["Executor capacity is exhausted"] };
  }
  return { status: "eligible", reasons: [] };
}

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
  decideGate?: (
    node: GraphNode,
    completed: ReadonlyMap<string, GraphNodeResult>,
    graphId: string,
  ) =>
    | { decision: "approve" | "reject" | "request_changes"; reason?: string; data?: unknown }
    | Promise<{ decision: "approve" | "reject" | "request_changes"; reason?: string; data?: unknown }>;
  handlers?: Readonly<Record<string, GraphFunctionHandler>>;
  executors?: Readonly<Record<string, GraphExecutionAdapter>>;
  /**
   * Verify implementations a `loop` node may bind through `verifierId`. The id
   * lives in the durable definition and the function stays in the caller, so a
   * resumed Graph re-binds the same verifier instead of silently falling back
   * to the shell verifier the definition never asked for.
   */
  verifiers?: Readonly<Record<string, GraphLoopVerifier>>;
  signal?: AbortSignal;
  onEvent?: (event: GraphEvent) => void;
  /** Internal owner guard used by idle maintenance. */
  workspaceGuard?: SessionLease;
  /** Internal attempt identity used only to bind automatic-recovery bookkeeping. */
  recoveryAttemptId?: string;
};

/** Reads a handler without inheriting anything from Object.prototype. */
export function graphHandler(options: RunEngineeringGraphOptions, id: string): GraphFunctionHandler | undefined {
  const descriptor = options.handlers ? Object.getOwnPropertyDescriptor(options.handlers, id) : undefined;
  return descriptor && "value" in descriptor && typeof descriptor.value === "function"
    ? (descriptor.value as GraphFunctionHandler)
    : undefined;
}

/** Reads an executor without inheriting anything from Object.prototype. */
export function graphExecutor(options: RunEngineeringGraphOptions, id: string): GraphExecutionAdapter | undefined {
  const descriptor = options.executors ? Object.getOwnPropertyDescriptor(options.executors, id) : undefined;
  return descriptor && "value" in descriptor && isRecord(descriptor.value)
    ? (descriptor.value as unknown as GraphExecutionAdapter)
    : undefined;
}

/** Reads a verifier without inheriting anything from Object.prototype. */
export function graphVerifier(options: RunEngineeringGraphOptions, id: string): GraphLoopVerifier | undefined {
  const descriptor = options.verifiers ? Object.getOwnPropertyDescriptor(options.verifiers, id) : undefined;
  return descriptor && "value" in descriptor && typeof descriptor.value === "function"
    ? (descriptor.value as GraphLoopVerifier)
    : undefined;
}
