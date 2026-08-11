/**
 * Pure helpers for loop mode: per-tab progress reduction and view-model
 * formatting for the LoopPanel. No DOM, no sockets, no i18n — unit-tested in
 * loop.test.ts. The panel renders straight from these so the component stays a
 * thin shell.
 */
import { clipLine, formatCostUsd, lastNonEmptyLine, loopOutcome } from "@seekforge/shared/format";
import type { LoopEvent, LoopResult, LoopStatus } from "../types";

/** Per-tab loop progress: the streamed events plus the final result (once done). */
export type LoopProgress = {
  /** Every loop.event received, in arrival order (the live feed). */
  events: LoopEvent[];
  /** Set once a loop.done event arrives; null while running / before any loop. */
  result: LoopResult | null;
  /** Retained independently because the bounded event feed may evict early analysis events. */
  requirements: Extract<LoopEvent, { type: "requirements.completed" }>["spec"] | null;
  acceptanceReview: Extract<LoopEvent, { type: "requirements.reviewed" }>["review"] | null;
};

export function loopWarnings(events: LoopEvent[]): string[] {
  return events
    .filter((event): event is Extract<LoopEvent, { type: "loop.warning" }> => event.type === "loop.warning")
    .map((event) => event.message);
}

const MAX_LOOP_EVENTS = 500;
const MAX_LIVE_OUTPUT = 12_000;

export function emptyLoopProgress(): LoopProgress {
  return { events: [], result: null, requirements: null, acceptanceReview: null };
}

/**
 * Folds one loop event into the tab's progress. `loop.done` also stashes the
 * final result; every event is appended to the feed.
 */
export function reduceLoopEvent(progress: LoopProgress, event: LoopEvent): LoopProgress {
  let events: LoopEvent[];
  const last = progress.events.at(-1);
  if (
    event.type === "verify.output" &&
    last?.type === "verify.output" &&
    last.iteration === event.iteration &&
    last.stream === event.stream
  ) {
    const chunk = `${last.chunk}${event.chunk}`.slice(-MAX_LIVE_OUTPUT);
    events = [...progress.events.slice(0, -1), { ...event, chunk }];
  } else {
    events = [...progress.events, event];
  }
  if (events.length > MAX_LOOP_EVENTS) events = events.slice(-MAX_LOOP_EVENTS);
  const result = event.type === "loop.done" ? event.result : progress.result;
  return {
    events,
    result,
    requirements:
      event.type === "requirements.completed"
        ? event.spec
        : event.type === "loop.done"
          ? (event.result.requirements ?? progress.requirements)
          : progress.requirements,
    acceptanceReview:
      event.type === "requirements.reviewed"
        ? event.review
        : event.type === "loop.done"
          ? (event.result.acceptanceReview ?? progress.acceptanceReview)
          : progress.acceptanceReview,
  };
}

/** Tone for a finished loop: only a clean pass is "ok"; everything else warns/danger. */
export type LoopTone = "ok" | "warn" | "danger";

export function loopStatusTone(status: LoopStatus): LoopTone {
  // The pass/cancelled/fail classification is shared across surfaces; only
  // the palette mapping is desktop's.
  switch (loopOutcome(status)) {
    case "pass":
      return "ok";
    case "cancelled":
    case "pending":
      return "warn";
    default:
      return "danger";
  }
}

/** Cost formatted as USD with 4 decimals (matches the chat usage footer style). */
export const formatCost = formatCostUsd;

/** A short tail of command output for the progress list (last line, clipped). */
export function outputTail(output: string, max = 120): string {
  return clipLine(lastNonEmptyLine(output), max);
}

/**
 * Flattens the event feed into renderable rows: one row per iteration that
 * collects its run cost (if any) and verify outcome (if any). Events for the
 * same iteration merge; the rows stay ordered by first-seen iteration.
 */
export type LoopRow = {
  iteration: number;
  /** Run cost once run.completed arrived for this iteration. */
  costUsd: number | null;
  /** Verify outcome once a verify event arrived for this iteration. */
  verify: { code: number; passed: boolean; tail: string } | null;
  /** Live verification output before the final verify event arrives. */
  liveTail: string;
  tokens: number | null;
  durationMs: number | null;
  changedPaths: number;
  failureCategory: string | null;
  /**
   * Per-stage verification outcomes (verify.stage.completed). The aggregate
   * `verify` output only keeps its last line, so with a multi-stage plan the
   * failing stage is almost never in it — these rows are what identifies it.
   */
  stages: LoopStageRow[];
  /** Stage currently executing (verify.stage.started, cleared when it completes). */
  activeStage: string | null;
  /** Stages that only passed after a retry (verify.flaky) — the retry switch is on this surface. */
  flaky: Array<{ stageId: string; attempts: number }>;
  /** Impact selection outcome (verify.impact): what the plan skipped or reused. */
  impact: { skipped: number; reused: number; blocked: number; fullFallback: boolean } | null;
  /** Workspace rollback performed for this iteration (loop.rollback). */
  rollback: { restored: number; deleted: number } | null;
};

/** One verification stage of an iteration, reduced for rendering. */
export type LoopStageRow = {
  id: string;
  code: number;
  passed: boolean;
  attempts: number;
  flaky: boolean;
  durationMs: number;
  /** Last non-empty output line of the stage, clipped (bounded rendering). */
  tail: string;
};

/** Per-iteration cap on rendered stage/flaky entries (bounded rendering). */
export const MAX_ROW_STAGES = 12;

export function loopRows(events: LoopEvent[]): LoopRow[] {
  const order: number[] = [];
  const byIter = new Map<number, LoopRow>();
  const ensure = (iteration: number): LoopRow => {
    let row = byIter.get(iteration);
    if (!row) {
      row = {
        iteration,
        costUsd: null,
        verify: null,
        liveTail: "",
        tokens: null,
        durationMs: null,
        changedPaths: 0,
        failureCategory: null,
        stages: [],
        activeStage: null,
        flaky: [],
        impact: null,
        rollback: null,
      };
      byIter.set(iteration, row);
      order.push(iteration);
    }
    return row;
  };
  for (const event of events) {
    switch (event.type) {
      case "iteration.start":
        ensure(event.iteration);
        break;
      case "run.completed":
        {
          const observed = event as typeof event & {
            iterationTokens?: number;
            durationMs?: number;
            changedPaths?: string[];
          };
          const row = ensure(event.iteration);
          row.costUsd = event.costUsd;
          row.tokens = observed.iterationTokens ?? null;
          row.durationMs = observed.durationMs ?? null;
          row.changedPaths = observed.changedPaths?.length ?? 0;
        }
        break;
      case "verify":
        ensure(event.iteration).verify = {
          code: event.code,
          passed: event.passed,
          tail: outputTail(event.output),
        };
        break;
      case "verify.output":
        ensure(event.iteration).liveTail = outputTail(event.chunk);
        break;
      case "loop.done":
        // Summary is rendered separately from the per-iteration rows.
        break;
      case "loop.warning":
        // Warnings are rendered separately from iteration rows.
        break;
      case "verify.stage.started":
        ensure(event.iteration).activeStage = event.stageId;
        break;
      case "verify.stage.completed":
        {
          const row = ensure(event.iteration);
          const result = event.result;
          const stage: LoopStageRow = {
            id: result.id,
            code: result.code,
            passed: result.code === 0,
            attempts: result.attempts,
            flaky: result.flaky,
            durationMs: result.durationMs,
            tail: outputTail(result.output),
          };
          const index = row.stages.findIndex((existing) => existing.id === stage.id);
          if (index >= 0) row.stages[index] = stage;
          else if (row.stages.length < MAX_ROW_STAGES) row.stages.push(stage);
          if (row.activeStage === stage.id) row.activeStage = null;
        }
        break;
      case "verify.flaky":
        {
          const row = ensure(event.iteration);
          const index = row.flaky.findIndex((entry) => entry.stageId === event.stageId);
          const entry = { stageId: event.stageId, attempts: event.attempts };
          if (index >= 0) row.flaky[index] = entry;
          else if (row.flaky.length < MAX_ROW_STAGES) row.flaky.push(entry);
        }
        break;
      case "verify.impact":
        {
          const row = ensure(event.iteration);
          let skipped = 0;
          let reused = 0;
          let blocked = 0;
          for (const decision of event.decisions) {
            if (decision.action === "skip") skipped++;
            else if (decision.action === "reuse") reused++;
            else if (decision.action === "blocked") blocked++;
          }
          row.impact = { skipped, reused, blocked, fullFallback: event.fullFallback };
        }
        break;
      case "loop.rollback":
        ensure(event.iteration).rollback = {
          restored: event.restored.length,
          deleted: event.deleted.length,
        };
        break;
      case "requirements.started":
      case "requirements.completed":
      case "requirements.reviewed":
      case "loop.paused":
      case "loop.resumed":
      case "loop.steered":
      case "loop.recovery":
        break;
      case "loop.snapshot":
        {
          const observed = event.snapshot as typeof event.snapshot & { failureCategory?: string };
          ensure(event.snapshot.iteration).failureCategory = observed.failureCategory ?? null;
        }
        break;
    }
  }
  return order.map((i) => byIter.get(i)!);
}

/** Longest rendered detail for one persisted-history row (bounded rendering). */
export const MAX_HISTORY_DETAIL = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Finite number or undefined — persisted history is transport data, not a typed union. */
function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function joinParts(parts: Array<string | undefined>): string {
  return clipLine(parts.filter((part) => part !== undefined && part !== "").join(" · "), MAX_HISTORY_DETAIL);
}

/**
 * The readable payload of one persisted Loop history event: exit codes, stage
 * ids, messages. The caller still prints `event.type`, so an unknown or
 * malformed event degrades to an empty detail rather than a dropped row — a
 * history that silently hides what happened misrepresents the Loop.
 *
 * Input is REST transport data typed only as `{ type: string; ... }`, so every
 * field is read defensively.
 */
export function loopHistoryDetail(event: { type: string; [key: string]: unknown }): string {
  const iteration = readNumber(event.iteration);
  const at = iteration === undefined ? undefined : `#${iteration}`;
  switch (event.type) {
    case "iteration.start":
      return joinParts([at]);
    case "run.completed":
      return joinParts([at, readNumber(event.costUsd) === undefined ? undefined : formatCost(event.costUsd as number)]);
    case "verify":
      return joinParts([
        at,
        `exit ${readNumber(event.code) ?? "?"}`,
        readString(event.output) === undefined ? undefined : outputTail(event.output as string),
      ]);
    case "verify.output":
      return joinParts([at, readString(event.stream), outputTail(readString(event.chunk) ?? "")]);
    case "verify.stage.started":
      return joinParts([at, readString(event.stageId), `attempt ${readNumber(event.attempt) ?? "?"}`]);
    case "verify.stage.completed": {
      const result = isRecord(event.result) ? event.result : undefined;
      return joinParts([
        at,
        readString(result?.id),
        `exit ${readNumber(result?.code) ?? "?"}`,
        result?.flaky === true ? "flaky" : undefined,
        readNumber(result?.durationMs) === undefined ? undefined : `${readNumber(result?.durationMs)}ms`,
        readString(result?.output) === undefined ? undefined : outputTail(result?.output as string),
      ]);
    }
    case "verify.flaky":
      return joinParts([at, readString(event.stageId), `${readNumber(event.attempts) ?? "?"} attempts`]);
    case "loop.model.routed":
      return joinParts([
        at,
        readString(event.category),
        readString(event.model) === undefined ? undefined : `→ ${readString(event.model)}`,
        `streak ${readNumber(event.consecutiveFailures) ?? "?"}`,
        event.reason === "escalated_category" ? "escalated" : undefined,
      ]);
    case "verify.impact":
      return joinParts([
        at,
        `${readLength(event.decisions)} decisions`,
        event.fullFallback === true ? "full fallback" : undefined,
      ]);
    case "loop.paused":
    case "loop.resumed":
    case "code_review.started":
      return joinParts([at]);
    case "loop.steered":
      return joinParts([at, `${readNumber(event.count) ?? "?"} message(s)`]);
    case "loop.recovery":
      return joinParts([at, `attempt ${readNumber(event.attempt) ?? "?"}`, readString(event.reason)]);
    case "loop.rollback":
      return joinParts([at, `${readLength(event.restored)} restored`, `${readLength(event.deleted)} deleted`]);
    case "loop.snapshot": {
      const snapshot = isRecord(event.snapshot) ? event.snapshot : undefined;
      const snapshotIteration = readNumber(snapshot?.iteration);
      return joinParts([
        snapshotIteration === undefined ? undefined : `#${snapshotIteration}`,
        readString(snapshot?.failureCategory),
        readNumber(snapshot?.failedTests) === undefined ? undefined : `${readNumber(snapshot?.failedTests)} failed`,
      ]);
    }
    case "requirements.started":
      return joinParts([readString(event.phase)]);
    case "requirements.completed": {
      const spec = isRecord(event.spec) ? event.spec : undefined;
      return joinParts([
        `${readLength(spec?.requirements)} requirement(s)`,
        event.approvalRequired === true ? "approval required" : undefined,
      ]);
    }
    case "requirements.reviewed": {
      const review = isRecord(event.review) ? event.review : undefined;
      return joinParts([review?.complete === true ? "complete" : "incomplete", `${readLength(review?.gaps)} gap(s)`]);
    }
    case "code_review.completed": {
      const review = isRecord(event.review) ? event.review : undefined;
      return joinParts([at, `${readLength(review?.findings)} finding(s)`, readString(review?.summary)]);
    }
    case "loop.memory.updated": {
      const memory = isRecord(event.memory) ? event.memory : undefined;
      const memoryIteration = readNumber(memory?.iteration);
      return joinParts([
        memoryIteration === undefined ? undefined : `#${memoryIteration}`,
        readString(memory?.failureCategory),
      ]);
    }
    case "loop.warning":
      return joinParts([readString(event.warning), readString(event.message)]);
    case "loop.done": {
      const result = isRecord(event.result) ? event.result : undefined;
      return joinParts([
        readString(result?.status),
        `${readNumber(result?.iterations) ?? "?"} iteration(s)`,
        readNumber(result?.costUsd) === undefined ? undefined : formatCost(result?.costUsd as number),
      ]);
    }
    default:
      return "";
  }
}
