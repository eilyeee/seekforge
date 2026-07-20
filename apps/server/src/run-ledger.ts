import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { acquireSessionLease, redactSecrets, SessionBusyError } from "@seekforge/core";
import { MAX_WS_PAYLOAD_BYTES } from "@seekforge/shared/protocol-limits";
import {
  appendProjectFile,
  projectFileIdentity,
  readProjectFile,
  removeProjectFile,
  visitProjectFileLines,
  writeProjectFileAtomic,
} from "./config.js";

export const SERVER_PROTOCOL_VERSION = 1;
export const SERVER_CAPABILITIES = [
  "runs.v1",
  "runs.cancel",
  "runs.background",
  "runs.background-disconnect-continues",
  "ws.replay",
  "ws.disconnect-cancels",
  "metrics.v1",
] as const;

export type RunSource = "ws" | "loop" | "schedule" | "trigger" | "background";
export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export type RunRecord = {
  runId: string;
  source: RunSource;
  status: RunStatus;
  attempt: number;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
  costUsd?: number;
  error?: { code: string; message: string };
  labels?: Record<string, string>;
};

export type RunEvent = {
  runId: string;
  seq: number;
  ts: string;
  frame: Record<string, unknown>;
};

export type RunEventPage = {
  events: RunEvent[];
  nextAfterSeq: number;
  hasMore: boolean;
};

type ActiveRun = { workspace: string; controller: AbortController };

function runId(): string {
  return `run-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactStructuredSecrets(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value !== "object" || value === null) return value;
  if (ancestors.has(value)) throw new TypeError("run event frame contains a circular value");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => redactStructuredSecrets(entry, ancestors));
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [redactSecrets(key), redactStructuredSecrets(entry, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function validStatus(value: unknown): value is RunStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "waiting" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function parseRecord(value: unknown): RunRecord | undefined {
  if (!plainObject(value)) return undefined;
  if (
    typeof value["runId"] !== "string" ||
    !/^run-[A-Za-z0-9-]+$/.test(value["runId"]) ||
    !["ws", "loop", "schedule", "trigger", "background"].includes(String(value["source"])) ||
    !validStatus(value["status"]) ||
    !Number.isSafeInteger(value["attempt"]) ||
    (value["attempt"] as number) <= 0 ||
    typeof value["workspace"] !== "string" ||
    value["workspace"] === "" ||
    !validTimestamp(value["createdAt"]) ||
    !validTimestamp(value["updatedAt"]) ||
    (value["sessionId"] !== undefined && typeof value["sessionId"] !== "string") ||
    (value["costUsd"] !== undefined &&
      (typeof value["costUsd"] !== "number" || !Number.isFinite(value["costUsd"]) || value["costUsd"] < 0)) ||
    (value["error"] !== undefined &&
      (!plainObject(value["error"]) ||
        typeof value["error"]["code"] !== "string" ||
        typeof value["error"]["message"] !== "string")) ||
    (value["labels"] !== undefined &&
      (!plainObject(value["labels"]) || Object.values(value["labels"]).some((entry) => typeof entry !== "string")))
  )
    return undefined;
  return value as RunRecord;
}

function readJsonLines(workspace: string, rel: string): unknown[] {
  const raw = readProjectFile(workspace, rel);
  if (raw === undefined) return [];
  const values: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      // JSONL recovery is the longest valid prefix. Never skip corruption and
      // accept later records, which could forge state after a torn write.
      break;
    }
  }
  return values;
}

function repairJsonLines(workspace: string, rel: string, valid: (value: unknown, index: number) => boolean): void {
  const raw = readProjectFile(workspace, rel);
  if (raw === undefined) return;
  const kept: string[] = [];
  let invalid = false;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      invalid = true;
      break;
    }
    if (!valid(value, kept.length)) {
      invalid = true;
      break;
    }
    kept.push(line);
  }
  if (invalid) {
    writeProjectFileAtomic(workspace, rel, kept.length > 0 ? `${kept.join("\n")}\n` : "");
  }
}

export function readRunLedger(workspace: string): RunRecord[] {
  const latest = new Map<string, RunRecord>();
  for (const value of readJsonLines(workspace, ".seekforge/runs.jsonl")) {
    const record = parseRecord(value);
    if (!record) break;
    latest.set(record.runId, record);
  }
  return [...latest.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export const RUN_EVENT_REPLAY_LIMIT = 500;
export const RUN_EVENT_MAX_LINE_BYTES = MAX_WS_PAYLOAD_BYTES;

export class RunEventTooLargeError extends Error {
  constructor() {
    super(`run event exceeds ${RUN_EVENT_MAX_LINE_BYTES} bytes`);
    this.name = "RunEventTooLargeError";
  }
}

export function readRunEventPage(
  workspace: string,
  id: string,
  afterSeq = 0,
  limit = RUN_EVENT_REPLAY_LIMIT,
): RunEventPage {
  if (
    !/^run-[A-Za-z0-9-]+$/.test(id) ||
    !Number.isSafeInteger(afterSeq) ||
    afterSeq < 0 ||
    !Number.isSafeInteger(limit) ||
    limit <= 0
  ) {
    return { events: [], nextAfterSeq: afterSeq, hasMore: false };
  }
  const events: RunEvent[] = [];
  let lastSeq = 0;
  let hasMore = false;
  visitProjectFileLines(workspace, `.seekforge/run-events/${id}.jsonl`, RUN_EVENT_MAX_LINE_BYTES, (line) => {
    if (line.trim() === "") return true;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return false;
    }
    if (!plainObject(value) || value["runId"] !== id || !Number.isSafeInteger(value["seq"])) return false;
    const seq = value["seq"] as number;
    if (seq <= lastSeq || seq <= 0 || !validTimestamp(value["ts"]) || !plainObject(value["frame"])) return false;
    lastSeq = seq;
    if (seq <= afterSeq) return true;
    if (events.length === limit) {
      hasMore = true;
      return false;
    }
    events.push(value as RunEvent);
    return true;
  });
  return { events, nextAfterSeq: events.at(-1)?.seq ?? afterSeq, hasMore };
}

export function readRunEvents(workspace: string, id: string, afterSeq = 0): RunEvent[] {
  return readRunEventPage(workspace, id, afterSeq).events;
}

/**
 * Once the append log for a workspace exceeds this many lines we compact it —
 * the ledger is append-only, so a long-lived server would otherwise grow it
 * without bound (every status change writes a fresh line).
 */
export const RUNS_LEDGER_COMPACTION_THRESHOLD = 1000;

/** After compaction, retain at most this many runs (most-recently-updated). */
export const RUNS_LEDGER_MAX_RETAINED = 500;

type LedgerState = { lines: number; identity: string | undefined };

const LEDGER_LEASE_ID = "server-run-ledger";
const LEDGER_LEASE_TIMEOUT_MS = 30_000;
const ledgerWaitArray = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function withLedgerLease<T>(workspace: string, operation: () => T): T {
  const deadline = Date.now() + LEDGER_LEASE_TIMEOUT_MS;
  let lease: ReturnType<typeof acquireSessionLease>;
  for (;;) {
    try {
      lease = acquireSessionLease(workspace, LEDGER_LEASE_ID);
      break;
    } catch (error) {
      const leaseReleaseRace = (error as NodeJS.ErrnoException).code === "ENOENT" && existsSync(workspace);
      if (!(error instanceof SessionBusyError) && !leaseReleaseRace) throw error;
      if (Date.now() >= deadline) throw error;
      Atomics.wait(ledgerWaitArray, 0, 0, 5);
    }
  }
  try {
    return operation();
  } finally {
    lease.release();
  }
}

export class RunManager {
  private readonly active = new Map<string, ActiveRun>();
  private readonly seq = new Map<string, number>();
  /** Per-workspace line count plus file identity used to detect peer-process writes. */
  private readonly ledger = new Map<string, LedgerState>();
  private readonly frameListeners = new Map<string, Set<(event: RunEvent, fileIdentity: string) => void>>();
  private started = 0;
  private completed = 0;
  private failed = 0;
  private cancelled = 0;
  private httpRequests = 0;
  private httpErrors = 0;
  private httpDurationMs = 0;

  create(input: {
    workspace: string;
    source: RunSource;
    attempt?: number;
    labels?: Record<string, string>;
  }): RunRecord {
    const now = new Date().toISOString();
    const record: RunRecord = {
      runId: runId(),
      source: input.source,
      status: "queued",
      attempt: input.attempt ?? 1,
      workspace: input.workspace,
      createdAt: now,
      updatedAt: now,
      ...(input.labels ? { labels: input.labels } : {}),
    };
    this.append(record);
    this.started += 1;
    return record;
  }

  start(id: string, workspace: string, controller: AbortController): RunRecord | undefined {
    this.active.set(id, { workspace, controller });
    return this.update(workspace, id, { status: "running" });
  }

  update(
    workspace: string,
    id: string,
    patch: Partial<Pick<RunRecord, "status" | "sessionId" | "costUsd" | "error">>,
  ): RunRecord | undefined {
    const current = this.get(workspace, id);
    if (!current) return undefined;
    const terminal =
      current.status === "waiting" ||
      current.status === "succeeded" ||
      current.status === "failed" ||
      current.status === "cancelled";
    if (terminal && patch.status !== undefined && patch.status !== current.status) {
      return current;
    }
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.append(next);
    if (patch.status && patch.status !== "queued" && patch.status !== "running") {
      this.active.delete(id);
      // Terminal run: drop its in-memory seq so the map does not grow without
      // bound over the server's lifetime (one entry per runId ever seen).
      this.seq.delete(id);
      if (current.status === "queued" || current.status === "running") {
        if (patch.status === "succeeded") this.completed += 1;
        if (patch.status === "failed") this.failed += 1;
        if (patch.status === "cancelled") this.cancelled += 1;
      }
    }
    return next;
  }

  appendFrame(
    workspace: string,
    id: string,
    frame: Record<string, unknown>,
    options: { cacheSequence?: boolean } = {},
  ): RunEvent {
    // Fast path: once we have the run's seq in memory we trust it and only
    // increment — no per-frame full-file reparse (that made an N-event run
    // O(N^2)). The one-time validation below happens on first touch of the run
    // in this process, which also covers crash recovery: after a restart the
    // cache is empty, so we repair any torn suffix and recover the last seq
    // from the file before continuing the sequence.
    const cached = this.seq.get(id);
    let nextSeq: number;
    if (cached !== undefined) {
      nextSeq = cached + 1;
    } else {
      let previousSeq = 0;
      repairJsonLines(workspace, `.seekforge/run-events/${id}.jsonl`, (value) => {
        if (!plainObject(value) || value["runId"] !== id || !Number.isSafeInteger(value["seq"])) return false;
        const seq = value["seq"] as number;
        if (seq <= previousSeq || seq <= 0 || !validTimestamp(value["ts"]) || !plainObject(value["frame"]))
          return false;
        previousSeq = seq;
        return true;
      });
      nextSeq = this.lastSeq(workspace, id) + 1;
    }
    const event = { runId: id, seq: nextSeq, ts: new Date().toISOString(), frame };
    // Redact before persisting: frames carry raw model/reasoning deltas and tool
    // results, any of which can contain a secret that would otherwise land on
    // disk in cleartext (and be readable via read_file). Redact string leaves
    // while the frame is still structured so multiline masks are escaped by the
    // final JSON serialization and cannot split the JSONL record.
    const persisted = { ...event, frame: redactStructuredSecrets(frame) };
    const serialized = JSON.stringify(persisted);
    if (Buffer.byteLength(serialized, "utf8") > RUN_EVENT_MAX_LINE_BYTES) {
      throw new RunEventTooLargeError();
    }
    const identity = appendProjectFile(workspace, `.seekforge/run-events/${id}.jsonl`, `${serialized}\n`);
    if (options.cacheSequence !== false) this.seq.set(id, nextSeq);
    else this.seq.delete(id);
    const listeners = this.frameListeners.get(`${workspace}\0${id}`);
    if (listeners) {
      for (const listener of [...listeners]) {
        try {
          listener(persisted as RunEvent, identity);
        } catch {
          // Subscribers are observational and must never fail the producer.
        }
      }
    }
    return event;
  }

  subscribeFrames(
    workspace: string,
    id: string,
    listener: (event: RunEvent, fileIdentity: string) => void,
  ): () => void {
    const key = `${workspace}\0${id}`;
    let listeners = this.frameListeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.frameListeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.frameListeners.delete(key);
    };
  }

  eventFileIdentity(workspace: string, id: string): string | undefined {
    return projectFileIdentity(workspace, `.seekforge/run-events/${id}.jsonl`);
  }

  cancel(workspace: string, id: string): RunRecord | undefined {
    const record = this.get(workspace, id);
    if (!record) return undefined;
    this.active.get(id)?.controller.abort();
    if (record.status === "queued" || record.status === "running") {
      const cancelled = this.update(workspace, id, {
        status: "cancelled",
        error: { code: "cancelled", message: "cancelled by user" },
      });
      if (cancelled) {
        this.appendFrame(
          workspace,
          id,
          { type: "error", code: "cancelled", message: "cancelled by user" },
          { cacheSequence: false },
        );
      }
      return cancelled;
    }
    return record;
  }

  ownsActiveRun(workspace: string, id: string): boolean {
    return this.active.get(id)?.workspace === workspace;
  }

  get(workspace: string, id: string): RunRecord | undefined {
    return readRunLedger(workspace).find((record) => record.runId === id);
  }

  list(workspace: string): RunRecord[] {
    return readRunLedger(workspace);
  }

  events(workspace: string, id: string, afterSeq = 0): RunEvent[] {
    return readRunEvents(workspace, id, afterSeq);
  }

  eventPage(workspace: string, id: string, afterSeq = 0): RunEventPage {
    return readRunEventPage(workspace, id, afterSeq);
  }

  metrics(): Record<string, number> {
    return {
      seekforge_runs_started_total: this.started,
      seekforge_runs_completed_total: this.completed,
      seekforge_runs_failed_total: this.failed,
      seekforge_runs_cancelled_total: this.cancelled,
      seekforge_runs_active: this.active.size,
      seekforge_http_requests_total: this.httpRequests,
      seekforge_http_errors_total: this.httpErrors,
      seekforge_http_request_duration_ms_total: this.httpDurationMs,
    };
  }

  recordHttp(status: number, durationMs: number): void {
    this.httpRequests += 1;
    if (status >= 500) this.httpErrors += 1;
    this.httpDurationMs += Math.max(0, durationMs);
  }

  private append(record: RunRecord): void {
    // Every writer takes the same cross-process lease, so compaction cannot
    // replace a snapshot while a peer appends. File identity keeps the cached
    // line count on the O(1) hot path while forcing a recount after any peer
    // append or atomic replacement.
    withLedgerLease(record.workspace, () => {
      const state = this.ensureLedger(record.workspace);
      appendProjectFile(record.workspace, ".seekforge/runs.jsonl", `${JSON.stringify(record)}\n`);
      state.lines += 1;
      state.identity = projectFileIdentity(record.workspace, ".seekforge/runs.jsonl");
      if (state.lines > RUNS_LEDGER_COMPACTION_THRESHOLD) this.compactLedger(record.workspace, state);
    });
  }

  /** Validate/repair after first touch or an append/replacement by another process. */
  private ensureLedger(workspace: string): LedgerState {
    let state = this.ledger.get(workspace);
    const identity = projectFileIdentity(workspace, ".seekforge/runs.jsonl");
    if (state === undefined || state.identity !== identity) {
      repairJsonLines(workspace, ".seekforge/runs.jsonl", (value) => parseRecord(value) !== undefined);
      state = {
        lines: this.countLedgerLines(workspace),
        identity: projectFileIdentity(workspace, ".seekforge/runs.jsonl"),
      };
      this.ledger.set(workspace, state);
    }
    return state;
  }

  private countLedgerLines(workspace: string): number {
    const raw = readProjectFile(workspace, ".seekforge/runs.jsonl");
    if (raw === undefined) return 0;
    let count = 0;
    for (const line of raw.split("\n")) if (line.trim() !== "") count += 1;
    return count;
  }

  /**
   * Collapse the append log to one record per run (its latest state), then
   * rewrite it chronologically. Crash-recovery semantics are preserved: the
   * rewritten file is exactly the latest valid state readRunLedger would report.
   *
   * Retention: keep EVERY non-terminal run (queued/running) unconditionally,
   * plus the most-recently-updated {@link RUNS_LEDGER_MAX_RETAINED} terminal
   * runs. A non-terminal run must never be evicted: its later terminal
   * `update()` reads the current record back from this file, so dropping it
   * would make that update a silent no-op — the terminal state never appended,
   * the active/seq maps leaked, and the completed/failed metrics never bumped.
   */
  private compactLedger(workspace: string, state: LedgerState): void {
    const isTerminal = (status: RunStatus): boolean =>
      status === "waiting" || status === "succeeded" || status === "failed" || status === "cancelled";
    const all = readRunLedger(workspace); // most-recently-updated first
    const nonTerminal = all.filter((record) => !isTerminal(record.status));
    const terminal = all.filter((record) => isTerminal(record.status)).slice(0, RUNS_LEDGER_MAX_RETAINED);
    const retained = [...nonTerminal, ...terminal];
    const ordered = [...retained].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const serialized = ordered.length > 0 ? `${ordered.map((r) => JSON.stringify(r)).join("\n")}\n` : "";
    writeProjectFileAtomic(workspace, ".seekforge/runs.jsonl", serialized);
    state.lines = ordered.length;
    state.identity = projectFileIdentity(workspace, ".seekforge/runs.jsonl");

    // Delete the per-run events file of every evicted (terminal, past-retention)
    // run — otherwise run-events/<id>.jsonl accumulates forever, unreferenced by
    // any ledger record. Also drop the evicted run's in-memory seq entry.
    const retainedIds = new Set(retained.map((record) => record.runId));
    for (const record of all) {
      if (retainedIds.has(record.runId)) continue;
      this.seq.delete(record.runId);
      // Path-safety: ids are internally generated, but never derive a filesystem
      // path from one containing a separator or traversal.
      if (/[/\\]|\.\./.test(record.runId)) continue;
      try {
        removeProjectFile(workspace, `.seekforge/run-events/${record.runId}.jsonl`);
      } catch {
        // best-effort: an events file that can't be removed is harmless garbage
      }
    }
  }

  private lastSeq(workspace: string, id: string): number {
    let last = 0;
    visitProjectFileLines(workspace, `.seekforge/run-events/${id}.jsonl`, RUN_EVENT_MAX_LINE_BYTES, (line) => {
      if (line.trim() === "") return true;
      try {
        const value = JSON.parse(line) as unknown;
        if (!plainObject(value) || value["runId"] !== id || !Number.isSafeInteger(value["seq"])) return false;
        const seq = value["seq"] as number;
        if (seq <= last || seq <= 0 || !validTimestamp(value["ts"]) || !plainObject(value["frame"])) return false;
        last = seq;
        return true;
      } catch {
        return false;
      }
    });
    return last;
  }
}
