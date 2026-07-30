import { createHash } from "node:crypto";
import type { GraphHistoryEntry } from "./graph-history.js";
import type { EngineeringGraphState, GraphNodeResult } from "./graph-state.js";
import type { LoopHistoryEntry } from "./loop-history.js";
import type { LoopState } from "./loop-state.js";
import { isRecord } from "../util/guards.js";

export type OrchestrationDiagnosticIssue = {
  severity: "warning" | "error";
  code: string;
  message: string;
  sequence?: number;
  nodeId?: string;
};

export type OrchestrationDiagnosticReport = {
  kind: "loop" | "graph";
  id: string;
  healthy: boolean;
  checkpointStatus: string;
  observedEvents: number;
  lastSequence: number;
  issues: OrchestrationDiagnosticIssue[];
};

export type OrchestrationReplayEntry<T> = { seq: number; event: T };

export type OrchestrationReplayReport = {
  kind: "loop" | "graph";
  id: string;
  events: number;
  lastSequence: number;
  digest: string;
  terminalStatus?: string;
  peakConcurrency: number;
  attempts: number;
  retries: number;
  pauses: number;
  warnings: number;
};

/** Replays a validated event window through a pure reducer. */
export function replayOrchestrationTransitions<State, Event>(
  initial: State,
  entries: readonly OrchestrationReplayEntry<Event>[],
  reduce: (state: State, event: Event, sequence: number) => State,
): State {
  let state = initial;
  let previous = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.seq) || entry.seq <= previous) {
      throw new Error("Orchestration replay sequence must be strictly increasing");
    }
    previous = entry.seq;
    state = reduce(state, entry.event, entry.seq);
  }
  return state;
}

function replayDigest(entries: readonly { seq: number; event: unknown }[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(`${entry.seq}\0${JSON.stringify(entry.event)}\n`);
  return hash.digest("hex");
}

/** Reconstructs deterministic Loop lifecycle metrics from the retained event window. */
export function replayLoopHistory(loopId: string, history: readonly LoopHistoryEntry[]): OrchestrationReplayReport {
  const replay = replayOrchestrationTransitions(
    { attempts: 0, retries: 0, pauses: 0, warnings: 0, terminalStatus: undefined as string | undefined },
    history,
    (state, event) => {
      const next = { ...state };
      if (event.type === "iteration.start") next.attempts += 1;
      if (event.type === "loop.recovery") next.retries += 1;
      if (event.type === "loop.paused") next.pauses += 1;
      if (event.type === "loop.warning") next.warnings += 1;
      if (event.type === "loop.done") next.terminalStatus = event.result.status;
      return next;
    },
  );
  return {
    kind: "loop",
    id: loopId,
    events: history.length,
    lastSequence: history.at(-1)?.seq ?? 0,
    digest: replayDigest(history),
    ...(replay.terminalStatus ? { terminalStatus: replay.terminalStatus } : {}),
    peakConcurrency: replay.attempts > 0 ? 1 : 0,
    attempts: replay.attempts,
    retries: replay.retries,
    pauses: replay.pauses,
    warnings: replay.warnings,
  };
}

/** Reconstructs deterministic Graph concurrency and lifecycle metrics from retained events. */
export function replayEngineeringGraphHistory(
  graphId: string,
  history: readonly GraphHistoryEntry[],
): OrchestrationReplayReport {
  const replay = replayOrchestrationTransitions(
    {
      active: new Set<string>(),
      seenAttempts: new Map<string, number>(),
      peakConcurrency: 0,
      attempts: 0,
      retries: 0,
      pauses: 0,
      warnings: 0,
      terminalStatus: undefined as string | undefined,
    },
    history,
    (state, event) => {
      const next = { ...state, active: new Set(state.active), seenAttempts: new Map(state.seenAttempts) };
      if (event.nodeId && event.type === "node.attempt.started") {
        next.active.add(event.nodeId);
        const count = (next.seenAttempts.get(event.nodeId) ?? 0) + 1;
        next.seenAttempts.set(event.nodeId, count);
        next.attempts += 1;
        if (count > 1) next.retries += 1;
        next.peakConcurrency = Math.max(next.peakConcurrency, next.active.size);
      }
      if (
        event.nodeId &&
        (event.type === "node.attempt.settled" || event.type === "node.completed" || event.type === "node.skipped")
      ) {
        next.active.delete(event.nodeId);
      }
      if (event.type === "graph.paused") next.pauses += 1;
      if (event.type === "graph.warning") next.warnings += 1;
      if (event.type === "graph.completed") next.terminalStatus = event.status;
      return next;
    },
  );
  return {
    kind: "graph",
    id: graphId,
    events: history.length,
    lastSequence: history.at(-1)?.seq ?? 0,
    digest: replayDigest(history),
    ...(replay.terminalStatus ? { terminalStatus: replay.terminalStatus } : {}),
    peakConcurrency: replay.peakConcurrency,
    attempts: replay.attempts,
    retries: replay.retries,
    pauses: replay.pauses,
    warnings: replay.warnings,
  };
}

function sequenceIssues(entries: readonly { seq: number }[]): OrchestrationDiagnosticIssue[] {
  const issues: OrchestrationDiagnosticIssue[] = [];
  let previous = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.seq) || entry.seq <= previous) {
      issues.push({
        severity: "error",
        code: "event_sequence_invalid",
        message: `Event sequence ${String(entry.seq)} does not follow ${previous}`,
        ...(Number.isSafeInteger(entry.seq) ? { sequence: entry.seq } : {}),
      });
      break;
    }
    previous = entry.seq;
  }
  return issues;
}

const terminalLoopStatuses = new Set([
  "passed",
  "exhausted",
  "no_progress",
  "budget",
  "cancelled",
  "verify_error",
  "agent_error",
]);

export function diagnoseLoopCheckpoint(
  state: LoopState,
  history: readonly LoopHistoryEntry[],
): OrchestrationDiagnosticReport {
  const issues = sequenceIssues(history);
  if (history.length === 0) {
    issues.push({
      severity: "warning",
      code: "history_unavailable",
      message: "No retained Loop history is available; only checkpoint invariants were checked",
    });
  }
  let highestIteration = 0;
  let lastDoneStatus: string | undefined;
  for (const entry of history) {
    const event = entry.event;
    if ("iteration" in event && typeof event.iteration === "number") {
      highestIteration = Math.max(highestIteration, event.iteration);
      if (!Number.isSafeInteger(event.iteration) || event.iteration < 0 || event.iteration > state.maxIterations) {
        issues.push({
          severity: "error",
          code: "iteration_out_of_bounds",
          message: `History iteration ${String(event.iteration)} is outside the checkpoint limit`,
          sequence: entry.seq,
        });
      }
    }
    if (event.type === "loop.done") {
      if (!isRecord(event.result) || typeof event.result.status !== "string") {
        issues.push({
          severity: "error",
          code: "event_payload_invalid",
          message: "A retained loop.done event has an invalid result payload",
          sequence: entry.seq,
        });
      } else {
        lastDoneStatus = event.result.status;
      }
    }
  }
  if (highestIteration > state.iterations) {
    issues.push({
      severity: "error",
      code: "history_ahead_of_checkpoint",
      message: `History reached iteration ${highestIteration}, but the checkpoint records ${state.iterations}`,
    });
  }
  const snapshots = state.snapshots ?? [];
  for (let index = 1; index < snapshots.length; index++) {
    if (snapshots[index]!.iteration <= snapshots[index - 1]!.iteration) {
      issues.push({
        severity: "error",
        code: "snapshot_order_invalid",
        message: "Loop snapshot iterations are not strictly increasing",
      });
      break;
    }
  }
  if ((snapshots.at(-1)?.iteration ?? 0) > state.iterations) {
    issues.push({
      severity: "error",
      code: "snapshot_ahead_of_checkpoint",
      message: "The latest Loop snapshot is newer than the checkpoint iteration",
    });
  }
  const lastEvent = history.at(-1)?.event;
  const lastEventStatus =
    lastEvent?.type === "loop.done" && isRecord(lastEvent.result) && typeof lastEvent.result.status === "string"
      ? lastEvent.result.status
      : undefined;
  if (lastEventStatus !== undefined && lastEventStatus !== state.status) {
    issues.push({
      severity: "error",
      code: "terminal_status_mismatch",
      message: `The latest durable outcome is ${lastEventStatus}, but the checkpoint is ${state.status}`,
    });
  } else if (lastDoneStatus && terminalLoopStatuses.has(state.status) && lastDoneStatus !== state.status) {
    issues.push({
      severity: "warning",
      code: "retained_terminal_status_differs",
      message: "The retained history ends in an older terminal generation",
    });
  }
  if (terminalLoopStatuses.has(state.status) && state.phase !== undefined && state.phase !== "settled") {
    issues.push({
      severity: "error",
      code: "terminal_phase_invalid",
      message: `Terminal Loop checkpoint retained phase ${state.phase}`,
    });
  }
  return {
    kind: "loop",
    id: state.loopId,
    healthy: !issues.some((issue) => issue.severity === "error"),
    checkpointStatus: state.status,
    observedEvents: history.length,
    lastSequence: history.at(-1)?.seq ?? 0,
    issues,
  };
}

type GraphReplayState = {
  started: Set<string>;
  settled: Set<string>;
  completedStatus?: string;
};

function replayGraphWindow(history: readonly GraphHistoryEntry[]): GraphReplayState {
  return replayOrchestrationTransitions<GraphReplayState, GraphHistoryEntry["event"]>(
    { started: new Set(), settled: new Set() },
    history,
    (state, event) => {
      const next = { ...state, started: new Set(state.started), settled: new Set(state.settled) };
      if (event.nodeId && (event.type === "node.started" || event.type === "node.attempt.started")) {
        next.started.add(event.nodeId);
      }
      if (event.nodeId && (event.type === "node.completed" || event.type === "node.skipped")) {
        next.settled.add(event.nodeId);
      }
      if (event.type === "graph.completed") next.completedStatus = event.status;
      return next;
    },
  );
}

function resultById(results: readonly GraphNodeResult[]): Map<string, GraphNodeResult> {
  return new Map(results.map((result) => [result.id, result]));
}

export function diagnoseEngineeringGraphCheckpoint(
  state: EngineeringGraphState,
  history: readonly GraphHistoryEntry[],
): OrchestrationDiagnosticReport {
  const effectiveHistory =
    history.length > 0
      ? history
      : (state.events.map((event) => ({ seq: event.sequence, event })) satisfies GraphHistoryEntry[]);
  const issues = sequenceIssues(effectiveHistory);
  if (effectiveHistory.length === 0) {
    issues.push({
      severity: "warning",
      code: "history_unavailable",
      message: "No retained Graph history is available; only checkpoint invariants were checked",
    });
  }
  let replay: GraphReplayState = { started: new Set(), settled: new Set() };
  try {
    replay = replayGraphWindow(effectiveHistory);
  } catch (error) {
    issues.push({
      severity: "error",
      code: "history_replay_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const results = resultById(state.results);
  for (const attempt of state.activeAttempts) {
    if (results.has(attempt.nodeId)) {
      issues.push({
        severity: "error",
        code: "active_attempt_has_result",
        message: `Node ${attempt.nodeId} has both an active attempt and a settled result`,
        nodeId: attempt.nodeId,
      });
    }
  }
  const retainedEvents = state.events;
  let previousEventSequence = 0;
  for (const event of retainedEvents) {
    if (event.sequence <= previousEventSequence) {
      issues.push({
        severity: "error",
        code: "checkpoint_event_sequence_invalid",
        message: "Checkpoint event sequence is not strictly increasing",
        sequence: event.sequence,
      });
      break;
    }
    previousEventSequence = event.sequence;
  }
  const lastEvent = effectiveHistory.at(-1)?.event;
  if (lastEvent?.type === "graph.completed" && lastEvent.status !== state.status) {
    issues.push({
      severity: "error",
      code: "terminal_status_mismatch",
      message: `The latest durable outcome is ${String(lastEvent.status)}, but the checkpoint is ${state.status}`,
    });
  } else if (
    replay.completedStatus &&
    ["passed", "failed", "cancelled"].includes(state.status) &&
    replay.completedStatus !== state.status
  ) {
    issues.push({
      severity: "warning",
      code: "retained_terminal_status_differs",
      message: "The retained history contains an older completed Graph generation",
    });
  }
  for (const nodeId of replay.settled) {
    if (!results.has(nodeId) && !state.activeAttempts.some((attempt) => attempt.nodeId === nodeId)) {
      issues.push({
        severity: "warning",
        code: "history_result_not_retained",
        message: `The retained history settled ${nodeId}, but the current generation invalidated its result`,
        nodeId,
      });
    }
  }
  return {
    kind: "graph",
    id: state.graphId,
    healthy: !issues.some((issue) => issue.severity === "error"),
    checkpointStatus: state.status,
    observedEvents: effectiveHistory.length,
    lastSequence: effectiveHistory.at(-1)?.seq ?? 0,
    issues,
  };
}
