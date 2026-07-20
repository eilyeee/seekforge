/**
 * Process-exit teardown with the async/sync split spelled out once:
 *
 *  - `onSignal` runs on beforeExit / SIGINT / SIGTERM, where async cleanup can
 *    still complete (the process keeps running until something calls exit).
 *    Handlers must NOT call process.exit — frontends own termination; these
 *    hooks only piggyback cleanup.
 *  - `onExit` runs on 'exit', where the event loop is gone: it MUST be
 *    synchronous (kill children, close fds) or the work silently never runs.
 *
 * Each call registers one set of once-listeners and returns an idempotent
 * disposer. Long-lived factories must call it when their owned resource is
 * permanently disposed so process-level listeners do not accumulate.
 */
export function installProcessTeardown(hooks: { onSignal?: () => void; onExit?: () => void }): () => void {
  if (hooks.onSignal) {
    process.once("beforeExit", hooks.onSignal);
    process.once("SIGINT", hooks.onSignal);
    process.once("SIGTERM", hooks.onSignal);
  }
  if (hooks.onExit) process.once("exit", hooks.onExit);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (hooks.onSignal) {
      process.removeListener("beforeExit", hooks.onSignal);
      process.removeListener("SIGINT", hooks.onSignal);
      process.removeListener("SIGTERM", hooks.onSignal);
    }
    if (hooks.onExit) process.removeListener("exit", hooks.onExit);
  };
}
