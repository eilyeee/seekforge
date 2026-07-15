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
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

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
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled";
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function parseRecord(value: unknown): RunRecord | undefined {
  if (!plainObject(value)) return undefined;
  if (
    typeof value["runId"] !== "string" || !/^run-[A-Za-z0-9-]+$/.test(value["runId"]) ||
    !["ws", "loop", "schedule", "trigger", "background"].includes(String(value["source"])) ||
    !validStatus(value["status"]) ||
    !Number.isSafeInteger(value["attempt"]) || (value["attempt"] as number) <= 0 ||
    typeof value["workspace"] !== "string" || value["workspace"] === "" ||
    !validTimestamp(value["createdAt"]) ||
    !validTimestamp(value["updatedAt"]) ||
    (value["sessionId"] !== undefined && typeof value["sessionId"] !== "string") ||
    (value["costUsd"] !== undefined &&
      (typeof value["costUsd"] !== "number" || !Number.isFinite(value["costUsd"]) || value["costUsd"] < 0)) ||
    (value["error"] !== undefined &&
      (!plainObject(value["error"]) || typeof value["error"]["code"] !== "string" || typeof value["error"]["message"] !== "string")) ||
    (value["labels"] !== undefined &&
      (!plainObject(value["labels"]) || Object.values(value["labels"]).some((entry) => typeof entry !== "string")))
  ) return undefined;
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

function repairJsonLines(
  workspace: string,
  rel: string,
  valid: (value: unknown, index: number) => boolean,
): void {
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
    if (
      seq <= lastSeq || seq <= 0 || !validTimestamp(value["ts"]) || !plainObject(value["frame"])
    ) break;
    lastSeq = seq;
    if (seq > afterSeq) events.push(value as RunEvent);
  }
  return events;
}

export class RunManager {
  private readonly active = new Map<string, ActiveRun>();
  private readonly seq = new Map<string, number>();
  private started = 0;
  private completed = 0;
  private failed = 0;
  private cancelled = 0;
  private httpRequests = 0;
  private httpErrors = 0;
  private httpDurationMs = 0;

  create(input: { workspace: string; source: RunSource; attempt?: number; labels?: Record<string, string> }): RunRecord {
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

  update(workspace: string, id: string, patch: Partial<Pick<RunRecord, "status" | "sessionId" | "costUsd" | "error">>): RunRecord | undefined {
    const current = this.get(workspace, id);
    if (!current) return undefined;
    const terminal = current.status === "succeeded" || current.status === "failed" || current.status === "cancelled";
    if (terminal && patch.status !== undefined && patch.status !== current.status) {
      return current;
    }
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.append(next);
    if (patch.status && patch.status !== "queued" && patch.status !== "running") {
      this.active.delete(id);
      if (current.status === "queued" || current.status === "running") {
        if (patch.status === "succeeded") this.completed += 1;
        if (patch.status === "failed") this.failed += 1;
        if (patch.status === "cancelled") this.cancelled += 1;
      }
    }
    return next;
  }

  appendFrame(workspace: string, id: string, frame: Record<string, unknown>): RunEvent {
    let previousSeq = 0;
    repairJsonLines(workspace, `.seekforge/run-events/${id}.jsonl`, (value) => {
      if (!plainObject(value) || value["runId"] !== id || !Number.isSafeInteger(value["seq"])) return false;
      const seq = value["seq"] as number;
      if (seq <= previousSeq || seq <= 0 || !validTimestamp(value["ts"]) || !plainObject(value["frame"])) return false;
      previousSeq = seq;
      return true;
    });
    const nextSeq = (this.seq.get(id) ?? this.lastSeq(workspace, id)) + 1;
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
    repairJsonLines(record.workspace, ".seekforge/runs.jsonl", (value) => parseRecord(value) !== undefined);
    appendProjectFile(record.workspace, ".seekforge/runs.jsonl", `${JSON.stringify(record)}\n`);
  }

  private lastSeq(workspace: string, id: string): number {
    const events = readRunEvents(workspace, id);
    return events.at(-1)?.seq ?? 0;
  }
}
