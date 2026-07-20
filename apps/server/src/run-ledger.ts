import { randomBytes } from "node:crypto";
import { appendProjectFile, readProjectFile, writeProjectFileAtomic } from "./config.js";

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

type ActiveRun = { workspace: string; controller: AbortController };

function runId(): string {
  return `run-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function readRunEvents(workspace: string, id: string, afterSeq = 0): RunEvent[] {
  if (!/^run-[A-Za-z0-9-]+$/.test(id) || !Number.isSafeInteger(afterSeq) || afterSeq < 0) return [];
  const events: RunEvent[] = [];
  let lastSeq = 0;
  for (const value of readJsonLines(workspace, `.seekforge/run-events/${id}.jsonl`)) {
    if (!plainObject(value) || value["runId"] !== id || !Number.isSafeInteger(value["seq"])) break;
    const seq = value["seq"] as number;
    if (seq <= lastSeq || seq <= 0 || !validTimestamp(value["ts"]) || !plainObject(value["frame"])) break;
    lastSeq = seq;
    if (seq > afterSeq) events.push(value as RunEvent);
  }
  return events;
}

/**
 * Once the append log for a workspace exceeds this many lines we compact it —
 * the ledger is append-only, so a long-lived server would otherwise grow it
 * without bound (every status change writes a fresh line).
 */
export const RUNS_LEDGER_COMPACTION_THRESHOLD = 1000;

/** After compaction, retain at most this many runs (most-recently-updated). */
export const RUNS_LEDGER_MAX_RETAINED = 500;

type LedgerState = { lines: number };

export class RunManager {
  private readonly active = new Map<string, ActiveRun>();
  private readonly seq = new Map<string, number>();
  /** Per-workspace validated line count; absence means "not yet touched this process". */
  private readonly ledger = new Map<string, LedgerState>();
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

  appendFrame(workspace: string, id: string, frame: Record<string, unknown>): RunEvent {
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
    this.seq.set(id, nextSeq);
    const event = { runId: id, seq: nextSeq, ts: new Date().toISOString(), frame };
    appendProjectFile(workspace, `.seekforge/run-events/${id}.jsonl`, `${JSON.stringify(event)}\n`);
    return event;
  }

  cancel(workspace: string, id: string): RunRecord | undefined {
    const record = this.get(workspace, id);
    if (!record) return undefined;
    this.active.get(id)?.controller.abort();
    if (record.status === "queued" || record.status === "running") {
      return this.update(workspace, id, {
        status: "cancelled",
        error: { code: "cancelled", message: "cancelled by user" },
      });
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
    // Hot path: trust the in-memory validated line count and only append. The
    // one-time validation happens on this process's FIRST touch of the
    // workspace ledger (see ensureLedger), which also handles crash recovery —
    // after a restart the cache is empty, so we repair any torn/forged suffix
    // before continuing. Re-reading + re-validating the whole file on every
    // append made an N-record ledger O(N^2).
    const state = this.ensureLedger(record.workspace);
    appendProjectFile(record.workspace, ".seekforge/runs.jsonl", `${JSON.stringify(record)}\n`);
    state.lines += 1;
    if (state.lines > RUNS_LEDGER_COMPACTION_THRESHOLD) this.compactLedger(record.workspace, state);
  }

  /** Validate/repair the append log once per process, caching its line count. */
  private ensureLedger(workspace: string): LedgerState {
    let state = this.ledger.get(workspace);
    if (state === undefined) {
      repairJsonLines(workspace, ".seekforge/runs.jsonl", (value) => parseRecord(value) !== undefined);
      state = { lines: this.countLedgerLines(workspace) };
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
  }

  private lastSeq(workspace: string, id: string): number {
    const events = readRunEvents(workspace, id);
    return events.at(-1)?.seq ?? 0;
  }
}
