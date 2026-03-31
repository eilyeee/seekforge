/**
 * Unbounded async event queue: bridges concurrent producers (parallel and
 * background dispatches) into the agent loop's single AsyncIterable. The
 * loop drains it synchronously between tool executions (drainNow) and
 * asynchronously while awaiting a turn's dispatch promises (wait / iterator).
 */

export type EventQueue<T> = {
  /** Enqueue an event. Ignored after end(). */
  push(ev: T): void;
  /** No more pushes; iteration finishes once the buffer is drained. */
  end(): void;
  /** Synchronously removes and returns everything buffered so far. */
  drainNow(): T[];
  /** Resolves as soon as the buffer is non-empty (or the queue has ended). */
  wait(): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<T>;
};

export function createEventQueue<T>(): EventQueue<T> {
  let buffer: T[] = [];
  let ended = false;
  let wakeups: (() => void)[] = [];

  const wake = (): void => {
    const pending = wakeups;
    wakeups = [];
    for (const resolve of pending) resolve();
  };

  const queue: EventQueue<T> = {
    push(ev) {
      if (ended) return;
      buffer.push(ev);
      wake();
    },
    end() {
      ended = true;
      wake();
    },
    drainNow() {
      if (buffer.length === 0) return [];
      const out = buffer;
      buffer = [];
      return out;
    },
    wait() {
      if (buffer.length > 0 || ended) return Promise.resolve();
      return new Promise((resolve) => wakeups.push(resolve));
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (buffer.length > 0) {
          yield buffer.shift() as T;
          continue;
        }
        if (ended) return;
        await queue.wait();
      }
    },
  };
  return queue;
}
