import { abortablePromise } from "../util/abort.js";

export type LoopControlState = "running" | "paused";

export type LoopControl = {
  pause: () => void;
  resume: () => void;
  steer: (message: string) => void;
  state: () => LoopControlState;
  drain: () => { state: LoopControlState; guidance: string[] };
  waitAtBoundary: (signal?: AbortSignal) => Promise<{ resumed: boolean; guidance: string[] }>;
};

/** Run-local control channel. Pause and steering are observed only at safe iteration boundaries. */
export function createLoopControl(
  options: { maxQueuedGuidance?: number; maxGuidanceLength?: number } = {},
): LoopControl {
  const maxQueued = Math.max(1, Math.min(options.maxQueuedGuidance ?? 16, 64));
  const maxLength = Math.max(1, Math.min(options.maxGuidanceLength ?? 4_000, 16_000));
  let paused = false;
  const waiters = new Set<() => void>();
  const guidance: string[] = [];

  const drain = (): { state: LoopControlState; guidance: string[] } => ({
    state: paused ? "paused" : "running",
    guidance: guidance.splice(0, guidance.length),
  });
  return {
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      for (const wake of waiters) wake();
      waiters.clear();
    },
    steer: (message) => {
      const normalized = message.trim().slice(0, maxLength);
      if (!normalized) return;
      guidance.push(normalized);
      if (guidance.length > maxQueued) guidance.splice(0, guidance.length - maxQueued);
    },
    state: () => (paused ? "paused" : "running"),
    drain,
    waitAtBoundary: async (signal) => {
      const wasPaused = paused;
      if (paused) {
        let wake: (() => void) | undefined;
        try {
          await abortablePromise(
            new Promise<void>((resolve) => {
              wake = resolve;
              waiters.add(resolve);
            }),
            signal,
            () => new Error("loop control wait cancelled"),
          );
        } finally {
          if (wake) waiters.delete(wake);
        }
      }
      return { resumed: wasPaused, guidance: drain().guidance };
    },
  };
}
