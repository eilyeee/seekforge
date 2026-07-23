/** Absolute safety ceiling shared by every autonomous-loop entry point. */
export const MAX_LOOP_ITERATIONS = 100;

/** Structured verifier input is larger than the user-facing output tail. */
export const MAX_VERIFY_DIAGNOSTIC_INPUT = 256_000;

/** Persistence failures are reported once, with a bounded message. */
export const MAX_LOOP_WARNING_LENGTH = 500;

/** Defaults for autonomous-loop resource guardrails. */
export const DEFAULT_LOOP_VERIFY_TIMEOUT_MS = 120_000;
export const DEFAULT_LOOP_AGENT_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_LOOP_AGENT_RETRIES = 1;

/** Coalesce high-frequency usage checkpoints without delaying terminal state. */
export const LOOP_CHECKPOINT_INTERVAL_MS = 250;

/** Keep bounded observability history: current log plus two rotated segments. */
export const MAX_LOOP_LOG_BYTES = 4 * 1024 * 1024;
export const MAX_LOOP_LOG_SEGMENTS = 3;
export const LOOP_LOG_FLUSH_INTERVAL_MS = 50;
