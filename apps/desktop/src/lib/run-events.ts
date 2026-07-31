import type { RunEventSummary } from "../types";

type RunEventPage = { events: RunEventSummary[]; nextAfterSeq: number; hasMore: boolean };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunEvent(value: unknown): value is RunEventSummary {
  return (
    record(value) &&
    Number.isSafeInteger(value.seq) &&
    (value.seq as number) > 0 &&
    typeof value.runId === "string" &&
    value.runId.length > 0 &&
    typeof value.ts === "string" &&
    record(value.frame)
  );
}

/** Reads a bounded event stream to its end while retaining only the requested tail. */
export async function fetchRunEventTail(
  fetchPage: (afterSeq: number) => Promise<RunEventPage>,
  maxEvents = 20,
  expectedRunId?: string,
): Promise<RunEventSummary[]> {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 500) {
    throw new Error("event tail size must be an integer from 1 to 500");
  }
  let afterSeq = 0;
  let tail: RunEventSummary[] = [];
  for (let pageCount = 0; pageCount < 200; pageCount++) {
    const page = await fetchPage(afterSeq);
    if (!record(page) || !Array.isArray(page.events) || !page.events.every(isRunEvent)) {
      throw new Error("run event page must contain valid events");
    }
    if (typeof page.hasMore !== "boolean") throw new Error("run event page has an invalid continuation flag");
    let previousSeq = afterSeq;
    for (const event of page.events) {
      if (event.seq <= previousSeq) throw new Error("run event sequence must advance monotonically");
      if (expectedRunId !== undefined && event.runId !== expectedRunId) {
        throw new Error("run event belongs to a different run");
      }
      previousSeq = event.seq;
    }
    tail = [...tail, ...page.events].slice(-maxEvents);
    if (!page.hasMore) return tail;
    if (
      !Number.isSafeInteger(page.nextAfterSeq) ||
      page.nextAfterSeq <= afterSeq ||
      page.nextAfterSeq !== page.events.at(-1)?.seq
    ) {
      throw new Error("run event pagination cursor did not advance");
    }
    afterSeq = page.nextAfterSeq;
  }
  throw new Error("run event pagination exceeded 200 pages");
}
