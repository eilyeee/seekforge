/**
 * The one owner of Node's timer-delay ceiling.
 *
 * This is a fact about the platform's timer API, not about any one feature, so
 * it does not belong to the module of whichever feature happened to need it
 * first. It lived in five places under four names — the Loop verification
 * contract, the idle scheduler, the Server's option check and two inline
 * literals in the provider — and a bound written five times is a bound that
 * drifts four ways.
 *
 * It sits in `@seekforge/shared` because that is the bottom of the dependency
 * graph: the package has zero runtime dependencies, and `@seekforge/core` and
 * `apps/server` both depend on it, so every consumer can reach it without
 * anyone importing upward.
 *
 * Sharing the number does NOT mean sharing one reaction to exceeding it, and
 * the callers deliberately differ:
 *  - **Reject** what a caller declares now. A `timeoutMs` a human or an API
 *    client just authored past this ceiling is a mistake worth a loud
 *    `RangeError`, because silently capping it hides that the request could not
 *    be honoured.
 *  - **Clamp** what is replayed or configured far upstream. A duration read
 *    back from a checkpoint an older build wrote, or a generous stream timeout
 *    in a config file, must not strand a resume or fail a request; capping it
 *    at the longest representable wait is the behaviour the caller intended.
 * Both are correct, and neither should be rewritten into the other.
 */

/**
 * Longest delay `setTimeout` can hold, in milliseconds (2³¹−1, ~24.8 days).
 *
 * The delay is stored in a signed 32-bit field. A larger value overflows, Node
 * warns, and the timer fires *immediately* — so the longest wait a caller can
 * ask for silently becomes the shortest one there is. That is not a theoretical
 * hazard here: a Loop stage timeout of 30 days aborted on the next tick and
 * read as a flaky verifier. Every duration that reaches a timer must be bounded
 * by this rather than by `Number.MAX_SAFE_INTEGER`.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
