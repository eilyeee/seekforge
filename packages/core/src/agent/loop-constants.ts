/** Absolute safety ceiling shared by every autonomous-loop entry point. */
export const MAX_LOOP_ITERATIONS = 100;

/** Structured verifier input is larger than the user-facing output tail. */
export const MAX_VERIFY_DIAGNOSTIC_INPUT = 256_000;

/** Persistence failures are reported once, with a bounded message. */
export const MAX_LOOP_WARNING_LENGTH = 500;
