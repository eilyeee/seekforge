const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type RecurringIdleTimer = { dispose(): void };

export type RecurringIdleTimerOptions = {
  initialDelayMs: number;
  intervalMs: number;
  run: () => unknown;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
};

export function idleTimerDelay(value: number | undefined, fallback: number, name: string, allowZero: boolean): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved > MAX_TIMER_DELAY_MS || (allowZero ? resolved < 0 : resolved <= 0)) {
    throw new RangeError(`${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
  return resolved;
}

function defaultSchedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return timer;
}

/** Shared non-overlapping timer lifecycle for idle memory and Loop work. */
export function createRecurringIdleTimer(options: RecurringIdleTimerOptions): RecurringIdleTimer {
  const schedule = options.schedule ?? defaultSchedule;
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let disposed = false;
  let timer: unknown;
  const scheduleNext = (delayMs: number): void => {
    if (disposed) return;
    timer = schedule(() => {
      timer = undefined;
      let running: unknown;
      try {
        running = options.run();
      } catch {
        scheduleNext(options.intervalMs);
        return;
      }
      if (running instanceof Promise) {
        void running.catch(() => undefined).finally(() => scheduleNext(options.intervalMs));
      } else scheduleNext(options.intervalMs);
    }, delayMs);
  };
  scheduleNext(options.initialDelayMs);
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
      }
    },
  };
}
