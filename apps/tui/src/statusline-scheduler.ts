import { runStatusLine, type StatusLineInput } from "./statusline.js";

/**
 * Throttle + cache wrapper around runStatusLine so the TUI never spawns the
 * status-line process on every render. A recompute is allowed only when:
 *   - the structured input changed since the last computed input, AND
 *   - at least `minIntervalMs` has elapsed since the last computed time.
 * The most recent successful output is cached and returned in the meantime;
 * failures keep the previous cached value (so the built-in line can take over
 * only when there has never been output).
 *
 * The scheduler is deliberately pure-ish: time and the runner are injected so
 * the decision logic ("should we recompute now?") is unit-testable without
 * spawning processes or sleeping.
 */
export type SchedulerState = {
  /** Last output we showed (null = nothing yet → fall back to built-in). */
  lastOutput: string | null;
  /** Serialized input that produced lastComputedAt's run. */
  lastInputKey: string | null;
  /** Timestamp (ms) of the last actual command invocation. */
  lastComputedAt: number;
};

export const initialSchedulerState: SchedulerState = {
  lastOutput: null,
  lastInputKey: null,
  lastComputedAt: 0,
};

/** Stable key for every value that can affect status-line output. */
export function inputKey(command: string, input: StatusLineInput): string {
  return JSON.stringify([
    command,
    input.model,
    input.cwd,
    input.sessionId ?? null,
    input.costUsd,
    input.contextPercent ?? null,
    input.approval ?? null,
    input.totalTokens ?? null,
  ]);
}

/**
 * Decides whether a recompute should happen now. Recompute when the input key
 * changed or enough time has elapsed since the last run.
 */
export function shouldRecompute(
  state: SchedulerState,
  command: string,
  input: StatusLineInput,
  now: number,
  minIntervalMs: number,
): boolean {
  if (state.lastInputKey === null) return true;
  const changed = inputKey(command, input) !== state.lastInputKey;
  const elapsed = now - state.lastComputedAt >= minIntervalMs;
  return changed && elapsed;
}

export type TickResult = {
  state: SchedulerState;
  /** Set when shouldRecompute was true; caller runs the command. */
  recomputed: boolean;
};

const DEFAULT_MIN_INTERVAL_MS = 1000;

/**
 * Advances the scheduler. When a recompute is due, invokes `run` (defaults to
 * the real runStatusLine), caches a non-null result, and stamps the time.
 * A null result from `run` leaves the previous cached output untouched.
 */
export function tick(
  state: SchedulerState,
  command: string,
  input: StatusLineInput,
  opts?: {
    now?: number;
    minIntervalMs?: number;
    run?: (command: string, input: StatusLineInput) => string | null;
  },
): TickResult {
  const now = opts?.now ?? Date.now();
  const minIntervalMs = opts?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  if (!shouldRecompute(state, command, input, now, minIntervalMs)) {
    return { state, recomputed: false };
  }
  const run = opts?.run ?? runStatusLine;
  const out = run(command, input);
  return {
    state: {
      lastOutput: out ?? state.lastOutput,
      lastInputKey: inputKey(command, input),
      lastComputedAt: now,
    },
    recomputed: true,
  };
}
