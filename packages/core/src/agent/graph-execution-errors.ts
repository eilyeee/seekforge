import { abortablePromise, onAbortOnce } from "../util/abort.js";
import { MAX_GRAPH_EVENT_MESSAGE_CHARS } from "./graph-state.js";

/**
 * Failure vocabulary of one Graph node attempt. The distinctions matter to the
 * scheduler: an execution error keeps the usage it already spent, a
 * non-retryable error must not be retried, and a paused subgraph is not a
 * failure at all.
 */
export class GraphNodeExecutionError extends Error {
  constructor(
    message: string,
    readonly usage: { costUsd: number; tokensUsed: number; sessionId?: string },
  ) {
    super(message);
    this.name = "GraphNodeExecutionError";
  }
}

export class GraphNodeTimeoutError extends Error {}

export class GraphNodeNonRetryableError extends Error {
  constructor(
    message: string,
    readonly usage?: { costUsd: number; tokensUsed: number; sessionId?: string },
  ) {
    super(message);
  }
}

export class GraphSubgraphPausedError extends Error {
  constructor(
    readonly childGraphId: string,
    readonly waitingFor: string[],
    readonly usage: { costUsd: number; tokensUsed: number },
  ) {
    super(`Subgraph ${childGraphId} is waiting for approval: ${waitingFor.join(", ")}`);
    this.name = "GraphSubgraphPausedError";
  }
}

/** Sleeps between retries, returning early (without throwing) on cancellation. */
export async function waitForGraphRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    try {
      await abortablePromise(
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, delayMs);
        }),
        signal,
        () => signal.reason ?? new Error("Graph retry wait cancelled"),
      );
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs an attempt under its own abort signal. A timeout aborts the attempt and
 * waits for it to settle, so a timed-out node never keeps running unobserved.
 */
export async function withGraphTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | undefined,
  parentSignal: AbortSignal | undefined,
): Promise<T> {
  const controller = new AbortController();
  const detach = onAbortOnce(parentSignal, () => controller.abort(parentSignal?.reason));
  let timer: NodeJS.Timeout | undefined;
  try {
    const running = operation(controller.signal);
    const timeout =
      timeoutMs === undefined
        ? undefined
        : new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new GraphNodeTimeoutError(`Graph node timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            timer.unref?.();
          });
    if (!timeout) return await running;
    try {
      return await Promise.race([running, timeout]);
    } catch (error) {
      if (error instanceof GraphNodeTimeoutError) {
        controller.abort(error);
        await running.catch(() => undefined);
      }
      throw error;
    }
  } finally {
    if (timer) clearTimeout(timer);
    detach();
  }
}

/** Bounded message for a retryable failure, safe to persist in the event log. */
export function retryableError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, MAX_GRAPH_EVENT_MESSAGE_CHARS)
    : String(error).slice(0, MAX_GRAPH_EVENT_MESSAGE_CHARS);
}
