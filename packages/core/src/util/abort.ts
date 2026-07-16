/**
 * Shared AbortSignal plumbing. Every async subsystem (provider, MCP, LSP,
 * runtime, subprocess, dispatch) needs the same two shapes:
 *
 *  - subscribe a once-listener that also fires when the signal is ALREADY
 *    aborted (closing the check-then-subscribe race), plus an idempotent
 *    unsubscribe for the settle path — {@link onAbortOnce};
 *  - race a promise against the signal, rejecting with a caller-defined
 *    error and always detaching the listener — {@link abortablePromise}.
 *
 * Only the plumbing is shared; what an abort *means* (cancel notification,
 * process kill, error type) stays at the call site.
 */

/**
 * Subscribe `onAbort` to `signal` exactly once. Fires immediately when the
 * signal is already aborted. Returns an idempotent unsubscribe to call when
 * the guarded operation settles; a no-op when `signal` is undefined.
 */
export function onAbortOnce(signal: AbortSignal | undefined, onAbort: () => void): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    signal.removeEventListener("abort", onAbort);
  };
}

/**
 * Resolve/reject with `promise`, unless `signal` aborts first — then reject
 * with `makeReason()`. Rejects synchronously when the signal is already
 * aborted (the promise is left running; callers that need to stop the
 * underlying work subscribe their own cancellation side effects).
 */
export function abortablePromise<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  makeReason: () => unknown,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(makeReason());
  return new Promise<T>((resolve, reject) => {
    const off = onAbortOnce(signal, () => reject(makeReason()));
    promise.then(
      (value) => {
        off();
        resolve(value);
      },
      (err: unknown) => {
        off();
        reject(err);
      },
    );
  });
}
