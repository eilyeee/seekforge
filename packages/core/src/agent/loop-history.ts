import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { readUtf8FileBoundedSync } from "../util/fs.js";
import { isRecord } from "../util/guards.js";
import type { LoopEvent } from "./auto-loop.js";
import { LOOP_LOG_FLUSH_INTERVAL_MS, MAX_LOOP_LOG_BYTES, MAX_LOOP_LOG_SEGMENTS } from "./loop-constants.js";
import { loopLogFile } from "./loop-state-paths.js";

export type LoopLogWriter = {
  append: (event: LoopEvent) => void;
  flush: () => void;
  close: () => void;
};

export type LoopHistoryEntry = { seq: number; ts: string; event: LoopEvent };

const loopLogSegments = (target: string): string[] =>
  Array.from({ length: MAX_LOOP_LOG_SEGMENTS }, (_, index) => (index === 0 ? target : `${target}.${index}`)).reverse();

function lastLoopSequence(target: string): number {
  let cursor = 0;
  for (const file of loopLogSegments(target)) {
    let raw: string;
    try {
      raw = readUtf8FileBoundedSync(file, MAX_LOOP_LOG_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      break;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as unknown;
        if (!isRecord(row)) break;
        cursor = Number.isSafeInteger(row.seq) && (row.seq as number) > cursor ? (row.seq as number) : cursor + 1;
      } catch {
        break;
      }
    }
  }
  return cursor;
}

/** Append one Loop event to the bounded JSONL history. */
export function appendLoopLog(workspace: string, loopId: string, event: LoopEvent): void {
  const writer = createLoopLogWriter(workspace, loopId);
  writer.append(event);
  writer.flush();
}

/** Reads the bounded current + rotated Loop JSONL history in chronological order. */
export function readLoopHistory(
  workspace: string,
  loopId: string,
  options: { afterSeq?: number; limit?: number; tail?: boolean } = {},
): LoopHistoryEntry[] {
  const target = loopLogFile(workspace, loopId);
  const afterSeq = Number.isSafeInteger(options.afterSeq) && options.afterSeq! >= 0 ? options.afterSeq! : 0;
  const limit = Number.isSafeInteger(options.limit) ? Math.max(1, Math.min(options.limit!, 2_000)) : 500;
  const eventTypes = new Set([
    "iteration.start",
    "run.completed",
    "verify.output",
    "verify",
    "verify.stage.started",
    "verify.stage.completed",
    "verify.flaky",
    "verify.impact",
    "loop.paused",
    "loop.resumed",
    "loop.steered",
    "loop.recovery",
    "loop.snapshot",
    "loop.rollback",
    "requirements.started",
    "requirements.completed",
    "requirements.reviewed",
    "code_review.started",
    "code_review.completed",
    "loop.memory.updated",
    "loop.warning",
    "loop.done",
  ]);
  const result: LoopHistoryEntry[] = [];
  let cursor = 0;
  for (const file of loopLogSegments(target)) {
    let raw: string;
    try {
      raw = readUtf8FileBoundedSync(file, MAX_LOOP_LOG_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      break;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let row: unknown;
      try {
        row = JSON.parse(line) as unknown;
      } catch {
        break;
      }
      if (
        !isRecord(row) ||
        typeof row.ts !== "string" ||
        !Number.isFinite(Date.parse(row.ts)) ||
        typeof row.type !== "string" ||
        !eventTypes.has(row.type)
      )
        break;
      cursor = Number.isSafeInteger(row.seq) && (row.seq as number) > cursor ? (row.seq as number) : cursor + 1;
      if (cursor <= afterSeq) continue;
      const { ts, seq: _seq, ...event } = row;
      result.push({ seq: cursor, ts, event: event as LoopEvent });
      if (!options.tail && result.length >= limit) return result;
      if (options.tail && result.length > limit) result.shift();
    }
  }
  return result;
}

/** Batches event writes and rotates bounded log segments before appending. */
export function createLoopLogWriter(workspace: string, loopId: string): LoopLogWriter {
  const target = loopLogFile(workspace, loopId);
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let sequence = lastLoopSequence(target);

  const rotate = (incomingBytes: number): void => {
    let currentBytes = 0;
    try {
      currentBytes = statSync(target).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (currentBytes === 0 || currentBytes + incomingBytes <= MAX_LOOP_LOG_BYTES) return;
    for (let segment = MAX_LOOP_LOG_SEGMENTS - 1; segment >= 1; segment--) {
      const source = segment === 1 ? target : `${target}.${segment - 1}`;
      const destination = `${target}.${segment}`;
      try {
        rmSync(destination, { force: true });
        renameSync(source, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  };

  const flush = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (pending === "") return;
    const batch = pending;
    pending = "";
    mkdirSync(dirname(target), { recursive: true });
    rotate(Buffer.byteLength(batch));
    appendFileSync(target, batch, { encoding: "utf8", mode: 0o600 });
  };

  const schedule = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      try {
        flush();
      } catch {
        // Scheduled observability writes are best-effort and cannot fail the loop.
      }
    }, LOOP_LOG_FLUSH_INTERVAL_MS);
    timer.unref?.();
  };

  return {
    append: (event) => {
      if (closed) return;
      pending += `${JSON.stringify({ seq: ++sequence, ts: new Date().toISOString(), ...event })}\n`;
      if (Buffer.byteLength(pending) >= 64 * 1024) flush();
      else schedule();
    },
    flush,
    close: () => {
      if (closed) return;
      closed = true;
      flush();
    },
  };
}
