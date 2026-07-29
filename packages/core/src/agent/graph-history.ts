import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { isRecord } from "../util/guards.js";
import { isValidLoopDagId } from "./loop-dag-validation.js";
import { MAX_GRAPH_HISTORY_SEGMENTS } from "./graph-contract.js";
import { type GraphEvent, parseGraphEvent } from "./graph-state.js";

const MAX_GRAPH_LOG_BYTES = 1024 * 1024;
const GRAPH_LOG_FLUSH_INTERVAL_MS = 100;

export type GraphHistoryEntry = { seq: number; event: GraphEvent };
export type GraphLogWriter = { append: (event: GraphEvent) => void; flush: () => void; close: () => void };

function graphLogPath(graphId: string): string {
  if (!isValidLoopDagId(graphId)) throw new Error(`Graph id must be safe: ${graphId}`);
  return `.seekforge/graphs/${graphId}.jsonl`;
}

const graphLogSegments = (target: string): string[] =>
  Array.from({ length: MAX_GRAPH_HISTORY_SEGMENTS }, (_, index) =>
    index === 0 ? target : `${target}.${index}`,
  ).reverse();

function parseHistoryRow(value: unknown): GraphHistoryEntry | null {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.seq) ||
    (value.seq as number) < 1 ||
    !isRecord(value.event) ||
    !parseGraphEvent(value.event)
  ) {
    return null;
  }
  return value as GraphHistoryEntry;
}

function lastGraphLogSequence(workspace: string, target: string): number {
  let sequence = 0;
  for (const file of graphLogSegments(target)) {
    let raw: string | undefined;
    try {
      raw = readWorkspaceStateFile(workspace, file, MAX_GRAPH_LOG_BYTES);
    } catch {
      continue;
    }
    if (raw === undefined) continue;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const parsed = parseHistoryRow(JSON.parse(line) as unknown);
        if (!parsed) break;
        sequence = Math.max(sequence, parsed.seq);
      } catch {
        break;
      }
    }
  }
  return sequence;
}

export function readEngineeringGraphHistory(
  workspace: string,
  graphId: string,
  options: { afterSeq?: number; limit?: number; tail?: boolean } = {},
): GraphHistoryEntry[] {
  const target = graphLogPath(graphId);
  const afterSeq = Number.isSafeInteger(options.afterSeq) && options.afterSeq! >= 0 ? options.afterSeq! : 0;
  const limit = Number.isSafeInteger(options.limit) ? Math.max(1, Math.min(options.limit!, 2_000)) : 500;
  const result: GraphHistoryEntry[] = [];
  let previous = 0;
  for (const file of graphLogSegments(target)) {
    let raw: string | undefined;
    try {
      raw = readWorkspaceStateFile(workspace, file, MAX_GRAPH_LOG_BYTES);
    } catch {
      continue;
    }
    if (raw === undefined) continue;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let parsed: GraphHistoryEntry | null;
      try {
        parsed = parseHistoryRow(JSON.parse(line) as unknown);
      } catch {
        break;
      }
      if (!parsed || parsed.seq <= previous) break;
      previous = parsed.seq;
      if (parsed.seq <= afterSeq) continue;
      result.push(parsed);
      if (!options.tail && result.length >= limit) return result;
      if (options.tail && result.length > limit) result.shift();
    }
  }
  return result;
}

export function engineeringGraphHistoryExists(workspace: string, graphId: string): boolean {
  try {
    return readWorkspaceStateFile(workspace, graphLogPath(graphId), MAX_GRAPH_LOG_BYTES) !== undefined;
  } catch {
    return false;
  }
}

export function createEngineeringGraphLogWriter(workspace: string, graphId: string): GraphLogWriter {
  const target = graphLogPath(graphId);
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const raw = readWorkspaceStateFile(workspace, target, MAX_GRAPH_LOG_BYTES);
  if (raw !== undefined) {
    const kept: string[] = [];
    let previous = 0;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let parsed: GraphHistoryEntry | null;
      try {
        parsed = parseHistoryRow(JSON.parse(line) as unknown);
      } catch {
        break;
      }
      if (!parsed || parsed.seq <= previous) break;
      previous = parsed.seq;
      kept.push(line);
    }
    const repaired = kept.length > 0 ? `${kept.join("\n")}\n` : "";
    if (repaired !== raw) writeWorkspaceStateFileAtomic(workspace, target, repaired);
  }
  let sequence = lastGraphLogSequence(workspace, target);

  const rotate = (current: string): void => {
    for (let segment = MAX_GRAPH_HISTORY_SEGMENTS - 1; segment >= 1; segment--) {
      const source = segment === 1 ? target : `${target}.${segment - 1}`;
      const destination = `${target}.${segment}`;
      try {
        const value = segment === 1 ? current : readWorkspaceStateFile(workspace, source, MAX_GRAPH_LOG_BYTES);
        writeWorkspaceStateFileAtomic(workspace, destination, value ?? "");
      } catch {
        // A damaged older segment must not prevent the current trace from rotating.
        writeWorkspaceStateFileAtomic(workspace, destination, "");
      }
    }
  };
  const flush = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (pending === "") return;
    const batch = pending;
    pending = "";
    try {
      const current = readWorkspaceStateFile(workspace, target, MAX_GRAPH_LOG_BYTES) ?? "";
      if (Buffer.byteLength(current) + Buffer.byteLength(batch) > MAX_GRAPH_LOG_BYTES) {
        rotate(current);
        writeWorkspaceStateFileAtomic(workspace, target, batch);
      } else {
        writeWorkspaceStateFileAtomic(workspace, target, `${current}${batch}`);
      }
    } catch (error) {
      pending = `${batch}${pending}`;
      throw error;
    }
  };
  const schedule = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      try {
        flush();
      } catch {
        // History is observability; the checkpoint remains authoritative.
      }
    }, GRAPH_LOG_FLUSH_INTERVAL_MS);
    timer.unref?.();
  };
  return {
    append: (event) => {
      if (closed) return;
      pending += `${JSON.stringify({ seq: ++sequence, event })}\n`;
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
