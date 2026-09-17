import { shutdownTelemetry } from "@seekforge/core";

/** The longest the TUI waits for telemetry on its way out. */
export const TELEMETRY_EXIT_TIMEOUT_MS = 5_000;

/**
 * Exports what telemetry still holds before the TUI ends the process — core
 * flushes on beforeExit and signals, which `process.exit` skips. Bounded, so an
 * unreachable collector never holds the terminal, and it never throws. A no-op
 * when telemetry is off.
 */
export async function flushTelemetryBeforeExit(
  timeoutMs: number = TELEMETRY_EXIT_TIMEOUT_MS,
  shutdown: () => Promise<void> = shutdownTelemetry,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(shutdown)
        .catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
