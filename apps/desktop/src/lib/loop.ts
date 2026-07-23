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
};

export function loopRows(events: LoopEvent[]): LoopRow[] {
  const order: number[] = [];
  const byIter = new Map<number, LoopRow>();
  const ensure = (iteration: number): LoopRow => {
    let row = byIter.get(iteration);
    if (!row) {
      row = { iteration, costUsd: null, verify: null, liveTail: "" };
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
        ensure(event.iteration).costUsd = event.costUsd;
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
      case "requirements.started":
      case "requirements.completed":
      case "requirements.reviewed":
      case "verify.stage.started":
      case "verify.stage.completed":
      case "verify.flaky":
      case "loop.paused":
      case "loop.resumed":
      case "loop.steered":
      case "loop.recovery":
      case "loop.snapshot":
      case "loop.rollback":
        // Requirement progress is rendered separately from iteration rows.
        break;
    }
  }
  return order.map((i) => byIter.get(i)!);
}
