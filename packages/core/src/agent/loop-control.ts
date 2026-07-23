import { abortablePromise } from "../util/abort.js";

export type LoopControlState = "running" | "paused";

export type LoopControl = {
  pause: () => void;
  resume: () => void;
  steer: (message: string) => void;
  state: () => LoopControlState;
  waitAtBoundary: (signal?: AbortSignal) => Promise<{ resumed: boolean; guidance: string[] }>;
};

/** Run-local control channel. Pause and steering are observed only at safe iteration boundaries. */
export function createLoopControl(
  options: { maxQueuedGuidance?: number; maxGuidanceLength?: number } = {},
): LoopControl {
  const maxQueued = Math.max(1, Math.min(options.maxQueuedGuidance ?? 16, 64));
  const maxLength = Math.max(1, Math.min(options.maxGuidanceLength ?? 4_000, 16_000));
  let paused = false;
  let wake: (() => void) | undefined;
  const guidance: string[] = [];

  return {
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      wake?.();
      wake = undefined;
    },
    steer: (message) => {
      const normalized = message.trim().slice(0, maxLength);
      if (!normalized) return;
      guidance.push(normalized);
      if (guidance.length > maxQueued) guidance.splice(0, guidance.length - maxQueued);
    },
    state: () => (paused ? "paused" : "running"),
    waitAtBoundary: async (signal) => {
      const wasPaused = paused;
      if (paused) {
        await abortablePromise(
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
          signal,
          () => new Error("loop control wait cancelled"),
        );
      }
      return { resumed: wasPaused, guidance: guidance.splice(0, guidance.length) };
    },
  };
}
