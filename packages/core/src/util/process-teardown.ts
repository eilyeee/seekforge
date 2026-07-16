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
 * Each call registers one set of once-listeners; callers keep their own
 * "installed" latch since laziness (install only once a resource exists) is
 * caller-specific.
 */
export function installProcessTeardown(hooks: { onSignal?: () => void; onExit?: () => void }): void {
  if (hooks.onSignal) {
    process.once("beforeExit", hooks.onSignal);
    process.once("SIGINT", hooks.onSignal);
    process.once("SIGTERM", hooks.onSignal);
  }
  if (hooks.onExit) process.once("exit", hooks.onExit);
}
