/**
 * The OTLP pipeline: in-memory cumulative sums and a bounded log queue, each
 * exported on its own timer.
 *
 * Observability must never become a way to break the thing it observes (see
 * docs/boundary-checklist.md #148). So: every record call is synchronous and
 * O(1); the queue is bounded and drops its oldest records; an export runs one
 * at a time per signal with a timeout; a failed export is swallowed and
 * counted; the timers are unref'd, so telemetry never keeps a process alive.
 */

import type { TokenUsage } from "@seekforge/shared";
import {
  type Attributes,
  encodeLogs,
  encodeMetrics,
  type LogRecord,
  type Scope,
  SEVERITY_ERROR,
  SEVERITY_INFO,
  type SumPoint,
} from "./otlp.js";
import type { TelemetrySettings } from "./config.js";

const MAX_QUEUED_LOGS = 2_048;
const MAX_LOGS_PER_REQUEST = 512;
const MAX_ATTRIBUTE_CHARS = 1_024;
const MAX_PROMPT_CHARS = 64_000;
/** Distinct metric series kept; a runaway label (tool names from a hostile MCP server) cannot grow memory. */
const MAX_SERIES = 1_024;

const METRICS = {
  sessions: { name: "seekforge.session.count", unit: "1", description: "Top-level agent sessions started" },
  tokens: { name: "seekforge.token.usage", unit: "tokens", description: "Tokens used, by type and model" },
  cost: { name: "seekforge.cost.usage", unit: "USD", description: "Estimated request cost, by model" },
  lines: {
    name: "seekforge.lines_of_code.count",
    unit: "1",
    description: "Lines added and removed by the agent's file edits",
  },
  decisions: {
    name: "seekforge.tool.decision",
    unit: "1",
    description: "Tool permission decisions, by tool, decision and source",
  },
  activeTime: {
    name: "seekforge.active_time.total",
    unit: "s",
    description: "Time top-level agent runs spent running",
  },
} as const;

type MetricId = keyof typeof METRICS;

export type TelemetryOptions = {
  settings: TelemetrySettings;
  /** Resource attributes SeekForge adds under the user's own (service.version, os.type, …). */
  defaultResource: Attributes;
  scope: Scope;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export type TelemetryStats = { exported: number; failed: number; dropped: number; lastError?: string };

export type ToolCallRecord = {
  toolName: string;
  ok: boolean;
  durationMs: number;
  errorCode: string | null;
  permissionDecision: string;
  args: unknown;
};

export type Telemetry = ReturnType<typeof createTelemetry>;

function clip(value: string, max = MAX_ATTRIBUTE_CHARS): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * What a permission decision was, and who made it. `undefined` for a call that
 * never reached the permission check (a malformed call, an unknown tool).
 */
export function classifyDecision(decision: string): { decision: "accept" | "reject"; source: string } | undefined {
  switch (decision) {
    case "user_approved":
      return { decision: "accept", source: "user" };
    case "user_denied":
      return { decision: "reject", source: "user" };
    case "session_allowlist":
      return { decision: "accept", source: "user_session" };
    case "allow_rule":
    case "allowlist":
      return { decision: "accept", source: "config" };
    case "deny_rule":
      return { decision: "reject", source: "config" };
    case "auto_policy":
    case "auto_accept_edits":
      return { decision: "accept", source: "mode" };
    case "forbidden_ask_mode":
      return { decision: "reject", source: "mode" };
    case "auto_readonly":
      return { decision: "accept", source: "readonly" };
    case "denied_dangerous":
      return { decision: "reject", source: "policy" };
    default:
      return undefined;
  }
}

function lines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

/** Lines one search/replace edit adds and removes, ignoring the lines both sides share at the ends. */
function editLineCounts(before: string, after: string): { added: number; removed: number } {
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { added: endB - start, removed: endA - start };
}

/**
 * Lines a successful built-in edit changed, from its arguments. `write_file`
 * counts its content as added: the file's previous content is gone by the time
 * the call is reported, so an overwrite's removals are not counted.
 */
export function linesChanged(toolName: string, args: unknown): { added: number; removed: number } | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  if (toolName === "write_file" && typeof record["content"] === "string") {
    return { added: lines(record["content"]).length, removed: 0 };
  }
  if (toolName === "apply_patch" && Array.isArray(record["edits"])) {
    let added = 0;
    let removed = 0;
    for (const edit of record["edits"]) {
      if (typeof edit !== "object" || edit === null) continue;
      const { oldString, newString } = edit as Record<string, unknown>;
      if (typeof oldString !== "string" || typeof newString !== "string") continue;
      const counts = editLineCounts(oldString, newString);
      added += counts.added;
      removed += counts.removed;
    }
    return { added, removed };
  }
  return undefined;
}

export function createTelemetry(options: TelemetryOptions) {
  const { settings, scope } = options;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const resource: Attributes = { ...options.defaultResource, ...settings.resource };
  const startedAt = now();
  const sums = new Map<string, SumPoint>();
  let metricsDirty = false;
  const queue: LogRecord[] = [];
  const stats: TelemetryStats = { exported: 0, failed: 0, dropped: 0 };
  let metricsInFlight: Promise<void> | undefined;
  let logsInFlight: Promise<void> | undefined;
  const sessionStarts = new Map<string, number>();
  let stopped = false;

  function add(id: MetricId, attributes: Attributes, value: number, integer = true): void {
    if (settings.metricsUrl === undefined || !(value > 0) || !Number.isFinite(value)) return;
    const metric = METRICS[id];
    const key = JSON.stringify([metric.name, Object.entries(attributes).sort()]);
    const existing = sums.get(key);
    if (existing) {
      existing.value += value;
    } else {
      if (sums.size >= MAX_SERIES) return;
      sums.set(key, { ...metric, attributes, value, integer });
    }
    metricsDirty = true;
  }

  function log(event: string, attributes: Attributes, severity = SEVERITY_INFO): void {
    if (settings.logsUrl === undefined || stopped) return;
    if (queue.length >= MAX_QUEUED_LOGS) {
      queue.shift();
      stats.dropped++;
    }
    queue.push({ timeMs: now(), severity, event: `seekforge.${event}`, attributes });
  }

  /** POST one body. Resolves to whether the records it carried should be tried again. */
  async function post(url: string, body: string): Promise<"sent" | "retry" | "drop"> {
    let lastError = "network error";
    // A pooled keep-alive socket the collector has just closed fails the POST
    // before it is sent, and fetch does not retry a POST itself. One immediate
    // second attempt gets a fresh connection; it matters most for the final
    // flush, which has no next export to catch up in.
    for (let attempt = 0; attempt < 2; attempt++) {
      const signal = AbortSignal.timeout(settings.timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { ...settings.headers, "content-type": "application/json" },
          body,
          signal,
        });
        await response.body?.cancel().catch(() => {});
        if (response.ok) {
          stats.exported++;
          return "sent";
        }
        stats.failed++;
        stats.lastError = `HTTP ${response.status}`;
        // The OTLP spec's retryable statuses; anything else will fail again.
        return [429, 502, 503, 504].includes(response.status) ? "retry" : "drop";
      } catch (error) {
        lastError = error instanceof Error ? error.name : "network error";
        // A timeout already spent the whole budget; do not spend it twice.
        if (signal.aborted) break;
      }
    }
    stats.failed++;
    stats.lastError = lastError;
    return "retry";
  }

  function exportMetrics(): Promise<void> {
    if (metricsInFlight) return metricsInFlight;
    if (settings.metricsUrl === undefined || !metricsDirty) return Promise.resolve();
    const url = settings.metricsUrl;
    metricsDirty = false;
    // Cumulative sums: a failed export needs no retry of its own, the next one
    // carries the same totals and more.
    const body = encodeMetrics(resource, scope, [...sums.values()], startedAt, now());
    metricsInFlight = post(url, body)
      .then((outcome) => {
        if (outcome === "retry") metricsDirty = true;
      })
      .finally(() => {
        metricsInFlight = undefined;
      });
    return metricsInFlight;
  }

  function exportLogs(): Promise<void> {
    if (logsInFlight) return logsInFlight;
    if (settings.logsUrl === undefined || queue.length === 0) return Promise.resolve();
    const url = settings.logsUrl;
    const batch = queue.splice(0, MAX_LOGS_PER_REQUEST);
    logsInFlight = post(url, encodeLogs(resource, scope, batch))
      .then((outcome) => {
        if (outcome !== "retry") return;
        // Put the batch back in front, keeping the queue bound: what no longer
        // fits is the oldest, and is dropped.
        const room = Math.max(0, MAX_QUEUED_LOGS - queue.length);
        const kept = batch.slice(Math.max(0, batch.length - room));
        stats.dropped += batch.length - kept.length;
        queue.unshift(...kept);
      })
      .finally(() => {
        logsInFlight = undefined;
      });
    return logsInFlight;
  }

  const timers = [
    setInterval(() => void exportMetrics(), settings.metricIntervalMs),
    setInterval(() => void exportLogs(), settings.logIntervalMs),
  ];
  for (const timer of timers) timer.unref();

  /** Export everything pending once (a retryable failure stays queued for the next try). */
  async function flush(): Promise<void> {
    await Promise.all([metricsInFlight, logsInFlight]);
    const pending: Promise<void>[] = [exportMetrics()];
    // A backlog larger than one request goes out in consecutive requests.
    const rounds = Math.ceil(queue.length / MAX_LOGS_PER_REQUEST);
    const drainLogs = async (): Promise<void> => {
      for (let i = 0; i < rounds && queue.length > 0; i++) {
        const failedBefore = stats.failed;
        await exportLogs();
        if (stats.failed !== failedBefore) break;
      }
    };
    pending.push(drainLogs());
    await Promise.all(pending);
  }

  return {
    /** A top-level run began with `prompt`; `newSession` is false for a later turn of a resumed session. */
    recordRunStart(sessionId: string, prompt: string, newSession: boolean): void {
      if (sessionStarts.size < MAX_SERIES) sessionStarts.set(sessionId, now());
      if (newSession) add("sessions", {}, 1);
      log("user_prompt", {
        "session.id": sessionId,
        prompt_length: prompt.length,
        ...(settings.logUserPrompts ? { prompt: clip(prompt, MAX_PROMPT_CHARS) } : {}),
      });
    },

    recordRunEnd(sessionId: string): void {
      const started = sessionStarts.get(sessionId);
      if (started === undefined) return;
      sessionStarts.delete(sessionId);
      add("activeTime", {}, (now() - started) / 1000, false);
    },

    recordApiRequest(model: string, usage: TokenUsage, durationMs: number, sessionId?: string): void {
      const cacheRead = usage.cacheHitTokens;
      const cacheCreation = usage.cacheWriteTokens ?? 0;
      const input = Math.max(0, usage.promptTokens - cacheRead - cacheCreation);
      const byType: Record<string, number> = {
        input,
        output: usage.completionTokens,
        cacheRead,
        cacheCreation,
        reasoning: usage.reasoningTokens ?? 0,
      };
      for (const [type, count] of Object.entries(byType)) add("tokens", { type, model }, count);
      add("cost", { model }, usage.costUsd, false);
      log("api_request", {
        ...(sessionId ? { "session.id": sessionId } : {}),
        model,
        input_tokens: input,
        output_tokens: usage.completionTokens,
        cache_read_tokens: cacheRead,
        cache_creation_tokens: cacheCreation,
        ...(usage.reasoningTokens !== undefined ? { reasoning_tokens: usage.reasoningTokens } : {}),
        cost_usd: usage.costUsd,
        duration_ms: Math.round(durationMs),
      });
    },

    recordApiError(model: string, error: unknown, durationMs: number, sessionId?: string): void {
      const status =
        typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
      log(
        "api_error",
        {
          ...(sessionId ? { "session.id": sessionId } : {}),
          model,
          error: clip(error instanceof Error ? error.message : String(error)),
          ...(status !== undefined ? { status_code: status } : {}),
          duration_ms: Math.round(durationMs),
        },
        SEVERITY_ERROR,
      );
    },

    recordToolCall(call: ToolCallRecord, sessionId: string): void {
      const classified = classifyDecision(call.permissionDecision);
      const toolName = clip(call.toolName, 256);
      if (classified) add("decisions", { tool_name: toolName, ...classified }, 1);
      if (call.ok) {
        const changed = linesChanged(call.toolName, call.args);
        if (changed) {
          add("lines", { type: "added" }, changed.added);
          add("lines", { type: "removed" }, changed.removed);
        }
      }
      log("tool_result", {
        "session.id": sessionId,
        tool_name: toolName,
        success: call.ok,
        duration_ms: Math.round(call.durationMs),
        ...(classified ? { decision: classified.decision, decision_source: classified.source } : {}),
        ...(call.errorCode ? { error_code: clip(call.errorCode, 128) } : {}),
      });
    },

    flush,

    /** Stop the timers and export what is pending. Idempotent. */
    async shutdown(): Promise<void> {
      if (stopped) return;
      for (const timer of timers) clearInterval(timer);
      await flush();
      stopped = true;
    },

    stats(): TelemetryStats {
      return { ...stats };
    },
  };
}
