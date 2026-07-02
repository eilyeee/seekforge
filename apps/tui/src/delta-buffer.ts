/**
 * Streaming-delta coalescer: model/thinking deltas and live command output
 * arrive per-token / per-chunk, and dispatching each one re-renders the
 * whole Ink frame — the source of visible flicker during runs. This wraps
 * the reducer dispatch so high-frequency actions are buffered and flushed
 * at most once per interval, while every OTHER action flushes the buffers
 * first so ordering is preserved (text never overtakes the tool row that
 * follows it, and vice versa).
 */

import type { ChatAction } from "./model.js";

export type BufferedDispatch = {
  dispatch: (action: ChatAction) => void;
  /** Flush pending buffers immediately (call when the run ends). */
  flush: () => void;
};

const DEFAULT_INTERVAL_MS = 50;

export function createBufferedDispatch(
  dispatch: (action: ChatAction) => void,
  intervalMs: number = DEFAULT_INTERVAL_MS,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
  cancel: (handle: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
): BufferedDispatch {
  let modelBuf = "";
  let thinkingBuf = "";
  // command.output chunks per stream, in arrival order.
  let outputBuf: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
  let timer: unknown = null;
  let inFlush = false;

  const flush = (): void => {
    // Re-entrancy guard: flush() calls the downstream dispatch, which could (if
    // the call graph ever changes) synchronously re-enter this dispatcher and
    // re-arm/flush, double-emitting a buffer. No current call site re-enters, so
    // this is purely defensive and a no-op on today's paths.
    if (inFlush) return;
    inFlush = true;
    try {
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      // Thinking precedes content within a turn; outputs follow their tool row.
      if (thinkingBuf !== "") {
        dispatch({ type: "thinking-delta", chunk: thinkingBuf });
        thinkingBuf = "";
      }
      if (modelBuf !== "") {
        dispatch({ type: "model-delta", chunk: modelBuf });
        modelBuf = "";
      }
      if (outputBuf.length > 0) {
        for (const o of outputBuf) {
          dispatch({ type: "event", event: { type: "command.output", stream: o.stream, chunk: o.chunk } });
        }
        outputBuf = [];
      }
    } finally {
      inFlush = false;
    }
  };

  const arm = (): void => {
    if (timer === null) {
      timer = schedule(flush, intervalMs);
    }
  };

  return {
    flush,
    dispatch: (action) => {
      if (action.type === "model-delta") {
        modelBuf += action.chunk;
        arm();
        return;
      }
      if (action.type === "thinking-delta") {
        thinkingBuf += action.chunk;
        arm();
        return;
      }
      if (action.type === "event" && action.event.type === "command.output") {
        const last = outputBuf[outputBuf.length - 1];
        if (last && last.stream === action.event.stream) {
          last.chunk += action.event.chunk;
        } else {
          outputBuf.push({ stream: action.event.stream, chunk: action.event.chunk });
        }
        arm();
        return;
      }
      // Any other action: preserve ordering by draining buffers first.
      flush();
      dispatch(action);
    },
  };
}
