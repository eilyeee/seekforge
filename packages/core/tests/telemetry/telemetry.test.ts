import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ChatResponse } from "@seekforge/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentCore } from "../../src/agent/loop.js";
import { DeepSeekApiError, type ChatProvider, type ChatRequest } from "../../src/provider/index.js";
import {
  activeTelemetry,
  classifyDecision,
  createTelemetryFromSettings,
  describeTelemetry,
  linesChanged,
  resetTelemetryForTests,
  resolveTelemetrySettings,
  shutdownTelemetry,
  withProviderTelemetry,
} from "../../src/telemetry/index.js";
import type { TelemetrySettings } from "../../src/telemetry/config.js";
import { createDefaultDispatcher } from "../../src/tools/index.js";

type Received = { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> };

const received: Received[] = [];
/** Status the collector answers with, by path; 200 when unset. */
const statusFor = new Map<string, number>();
let collector: Server;
let endpoint: string;

beforeAll(async () => {
  collector = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const path = request.url ?? "";
      received.push({ path, headers: request.headers, body: JSON.parse(body) as Record<string, unknown> });
      response.writeHead(statusFor.get(path) ?? 200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
});

afterAll(async () => {
  collector.closeAllConnections();
  await new Promise<void>((resolve) => collector.close(() => resolve()));
});

beforeEach(async () => {
  received.length = 0;
  statusFor.clear();
  await resetTelemetryForTests();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await resetTelemetryForTests();
});

function settings(overrides: Partial<TelemetrySettings> = {}): TelemetrySettings {
  return {
    metricsUrl: `${endpoint}/v1/metrics`,
    logsUrl: `${endpoint}/v1/logs`,
    headers: { authorization: "Bearer collector-token" },
    timeoutMs: 2_000,
    metricIntervalMs: 60_000,
    logIntervalMs: 60_000,
    resource: { "deployment.environment": "test" },
    logUserPrompts: false,
    ...overrides,
  };
}

type Kv = { key: string; value: Record<string, unknown> };
const attrs = (list: unknown): Record<string, unknown> =>
  Object.fromEntries((list as Kv[]).map(({ key, value }) => [key, Object.values(value)[0]]));

function logRecords(): Array<Record<string, unknown>> {
  return received
    .filter((r) => r.path === "/v1/logs")
    .flatMap((r) =>
      (r.body["resourceLogs"] as Array<{ scopeLogs: Array<{ logRecords: Array<{ attributes: unknown }> }> }>).flatMap(
        (rl) => rl.scopeLogs.flatMap((sl) => sl.logRecords.map((record) => attrs(record.attributes))),
      ),
    );
}

/** The latest cumulative value of every series, keyed `name{attr=value,...}`. */
function metricSeries(): Record<string, string | number> {
  const latest = received.filter((r) => r.path === "/v1/metrics").at(-1);
  const out: Record<string, string | number> = {};
  if (!latest) return out;
  const resourceMetrics = latest.body["resourceMetrics"] as Array<{
    scopeMetrics: Array<{
      metrics: Array<{
        name: string;
        sum: { aggregationTemporality: number; isMonotonic: boolean; dataPoints: Array<Record<string, unknown>> };
      }>;
    }>;
  }>;
  for (const metric of resourceMetrics[0]!.scopeMetrics[0]!.metrics) {
    expect(metric.sum.aggregationTemporality).toBe(2);
    expect(metric.sum.isMonotonic).toBe(true);
    for (const point of metric.sum.dataPoints) {
      const labels = Object.entries(attrs(point["attributes"]))
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(",");
      out[`${metric.name}{${labels}}`] = (point["asInt"] as string | undefined) ?? (point["asDouble"] as number);
    }
  }
  return out;
}

const USAGE = {
  promptTokens: 1_000,
  completionTokens: 200,
  cacheHitTokens: 600,
  cacheWriteTokens: 100,
  reasoningTokens: 50,
  costUsd: 0.25,
};

describe("telemetry settings", () => {
  it("is off unless SEEKFORGE_ENABLE_TELEMETRY asks for it", () => {
    expect(resolveTelemetrySettings({}).enabled).toBe(false);
    expect(resolveTelemetrySettings({ SEEKFORGE_ENABLE_TELEMETRY: "0" }).enabled).toBe(false);
    expect(resolveTelemetrySettings({ SEEKFORGE_ENABLE_TELEMETRY: "TRUE" }).enabled).toBe(true);
  });

  it("reads the standard exporter variables", () => {
    const resolution = resolveTelemetrySettings({
      SEEKFORGE_ENABLE_TELEMETRY: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example:4318/",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://logs.example/ingest",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20abc, x-team = forge ,bad header=x,=novalue",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_METRIC_EXPORT_INTERVAL: "5",
      OTEL_BLRP_SCHEDULE_DELAY: "2500",
      OTEL_EXPORTER_OTLP_TIMEOUT: "3000",
      OTEL_RESOURCE_ATTRIBUTES: "team=core,deployment.environment=ci%2Fnightly",
      OTEL_SERVICE_NAME: "forge-bot",
      OTEL_LOG_USER_PROMPTS: "1",
    });
    expect(resolution.enabled).toBe(true);
    if (!resolution.enabled) return;
    expect(resolution.settings).toEqual({
      metricsUrl: "https://collector.example:4318/v1/metrics",
      logsUrl: "https://logs.example/ingest",
      headers: { authorization: "Bearer abc", "x-team": "forge" },
      timeoutMs: 3_000,
      metricIntervalMs: 1_000,
      logIntervalMs: 2_500,
      resource: { team: "core", "deployment.environment": "ci/nightly", "service.name": "forge-bot" },
      logUserPrompts: true,
    });
    expect(resolution.warnings).toHaveLength(2);
    expect(resolution.warnings.join(" ")).not.toContain("abc");
  });

  it("refuses a protocol it does not speak, and an exporter it does not have", () => {
    const grpc = resolveTelemetrySettings({ SEEKFORGE_ENABLE_TELEMETRY: "1", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" });
    expect(grpc.enabled).toBe(false);
    expect(grpc.warnings[0]).toMatch(/http\/json only/);

    const logsOnly = resolveTelemetrySettings({
      SEEKFORGE_ENABLE_TELEMETRY: "1",
      OTEL_METRICS_EXPORTER: "prometheus",
      OTEL_LOGS_EXPORTER: "otlp",
    });
    expect(logsOnly.enabled && logsOnly.settings.metricsUrl).toBeUndefined();
    expect(logsOnly.enabled && logsOnly.settings.logsUrl).toBe("http://localhost:4318/v1/logs");

    const neither = resolveTelemetrySettings({
      SEEKFORGE_ENABLE_TELEMETRY: "1",
      OTEL_METRICS_EXPORTER: "none",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "file:///tmp/logs",
    });
    expect(neither.enabled).toBe(false);
  });

  it("describes itself for doctor without credentials", () => {
    expect(describeTelemetry({}).enabled).toBe(false);
    const on = describeTelemetry({
      SEEKFORGE_ENABLE_TELEMETRY: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:secret@collector.example/otlp?token=t",
    });
    expect(on.detail).toBe(
      "OTLP http/json: metrics → https://collector.example/otlp/v1/metrics, logs → https://collector.example/otlp/v1/logs",
    );
  });
});

describe("telemetry pipeline", () => {
  it("exports metrics and events as OTLP/JSON with the configured headers and resource", async () => {
    const telemetry = createTelemetryFromSettings(settings());
    telemetry.recordRunStart("s-1", "fix the flaky test please", true);
    telemetry.recordApiRequest("deepseek-v4-flash", USAGE, 1234.4, "s-1");
    telemetry.recordApiRequest("deepseek-v4-flash", USAGE, 10);
    telemetry.recordApiError("deepseek-v4-flash", new DeepSeekApiError("DeepSeek API error HTTP 503", 503), 50, "s-1");
    telemetry.recordToolCall(
      {
        toolName: "apply_patch",
        ok: true,
        durationMs: 12,
        errorCode: null,
        permissionDecision: "user_approved",
        args: { path: "a.ts", edits: [{ oldString: "a\nb\nc\n", newString: "a\nB\nB2\nc\n" }] },
      },
      "s-1",
    );
    telemetry.recordToolCall(
      {
        toolName: "run_command",
        ok: false,
        durationMs: 3,
        errorCode: "permission_denied",
        permissionDecision: "deny_rule",
        args: { command: "rm -rf /" },
      },
      "s-1",
    );
    telemetry.recordRunEnd("s-1");
    telemetry.recordRunStart("s-1", "and the other one", false);
    telemetry.recordRunEnd("s-1");
    await telemetry.shutdown();

    for (const request of received) {
      expect(request.headers["content-type"]).toBe("application/json");
      expect(request.headers["authorization"]).toBe("Bearer collector-token");
    }
    const metrics = received.find((r) => r.path === "/v1/metrics")!;
    const resource = attrs(
      (metrics.body["resourceMetrics"] as Array<{ resource: { attributes: unknown } }>)[0]!.resource.attributes,
    );
    expect(resource).toMatchObject({ "service.name": "seekforge", "deployment.environment": "test" });

    expect(metricSeries()).toMatchObject({
      "seekforge.session.count{}": "1",
      "seekforge.token.usage{model=deepseek-v4-flash,type=input}": "600",
      "seekforge.token.usage{model=deepseek-v4-flash,type=output}": "400",
      "seekforge.token.usage{model=deepseek-v4-flash,type=cacheRead}": "1200",
      "seekforge.token.usage{model=deepseek-v4-flash,type=cacheCreation}": "200",
      "seekforge.token.usage{model=deepseek-v4-flash,type=reasoning}": "100",
      "seekforge.cost.usage{model=deepseek-v4-flash}": 0.5,
      "seekforge.lines_of_code.count{type=added}": "2",
      "seekforge.lines_of_code.count{type=removed}": "1",
      "seekforge.tool.decision{decision=accept,source=user,tool_name=apply_patch}": "1",
      "seekforge.tool.decision{decision=reject,source=config,tool_name=run_command}": "1",
    });
    expect(Object.keys(metricSeries())).toContain("seekforge.active_time.total{}");

    const events = logRecords();
    expect(events.map((e) => e["event.name"])).toEqual([
      "seekforge.user_prompt",
      "seekforge.api_request",
      "seekforge.api_request",
      "seekforge.api_error",
      "seekforge.tool_result",
      "seekforge.tool_result",
      "seekforge.user_prompt",
    ]);
    expect(events[0]).toEqual({ "event.name": "seekforge.user_prompt", "session.id": "s-1", prompt_length: "25" });
    expect(events[1]).toMatchObject({
      model: "deepseek-v4-flash",
      input_tokens: "300",
      cache_read_tokens: "600",
      cache_creation_tokens: "100",
      reasoning_tokens: "50",
      cost_usd: 0.25,
      duration_ms: "1234",
      "session.id": "s-1",
    });
    expect(events[2]).not.toHaveProperty("session.id");
    expect(events[3]).toMatchObject({ status_code: "503", error: "DeepSeek API error HTTP 503" });
    expect(events[5]).toEqual({
      "event.name": "seekforge.tool_result",
      "session.id": "s-1",
      tool_name: "run_command",
      success: false,
      duration_ms: "3",
      decision: "reject",
      decision_source: "config",
      error_code: "permission_denied",
    });
    // Tool arguments never leave the machine.
    expect(JSON.stringify(received)).not.toContain("rm -rf");
  });

  it("sends the prompt text only when OTEL_LOG_USER_PROMPTS asked for it", async () => {
    const telemetry = createTelemetryFromSettings(settings({ logUserPrompts: true, metricsUrl: undefined }));
    telemetry.recordRunStart("s-2", "secret plan", true);
    await telemetry.shutdown();
    expect(received.map((r) => r.path)).toEqual(["/v1/logs"]);
    expect(logRecords()[0]).toMatchObject({ prompt: "secret plan", prompt_length: "11" });
  });

  it("keeps records through a retryable failure, drops them on a rejection, and never throws", async () => {
    const telemetry = createTelemetryFromSettings(settings());
    statusFor.set("/v1/logs", 503);
    statusFor.set("/v1/metrics", 502);
    telemetry.recordRunStart("s-3", "x", true);
    await telemetry.flush();
    expect(telemetry.stats()).toMatchObject({
      exported: 0,
      failed: 2,
      lastError: expect.stringMatching(/^HTTP 50[23]$/),
    });

    statusFor.clear();
    received.length = 0;
    await telemetry.flush();
    expect(logRecords()).toHaveLength(1);
    expect(metricSeries()).toMatchObject({ "seekforge.session.count{}": "1" });

    statusFor.set("/v1/logs", 400);
    telemetry.recordRunStart("s-4", "y", true);
    await telemetry.flush();
    received.length = 0;
    statusFor.set("/v1/logs", 200);
    await telemetry.flush();
    expect(logRecords()).toHaveLength(0);
    await telemetry.shutdown();
  });

  it("retries a request whose connection failed once, and only once", async () => {
    let calls = 0;
    const flaky: typeof fetch = async (input, init) => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed: other side closed");
      return fetch(input, init);
    };
    const telemetry = createTelemetryFromSettings(settings({ metricsUrl: undefined }), flaky);
    telemetry.recordRunStart("s-6", "q", true);
    await telemetry.shutdown();
    expect(calls).toBe(2);
    expect(telemetry.stats()).toMatchObject({ exported: 1, failed: 0 });
    expect(logRecords()).toHaveLength(1);

    let attempts = 0;
    const down: typeof fetch = async () => {
      attempts++;
      throw new TypeError("fetch failed");
    };
    const unlucky = createTelemetryFromSettings(settings({ metricsUrl: undefined }), down);
    unlucky.recordRunStart("s-7", "q", true);
    await unlucky.flush();
    expect(attempts).toBe(2);
    expect(unlucky.stats()).toMatchObject({ exported: 0, failed: 1, lastError: "TypeError" });
    await unlucky.shutdown();
  });

  it("survives an unreachable collector", async () => {
    const telemetry = createTelemetryFromSettings(
      settings({ metricsUrl: "http://127.0.0.1:9/v1/metrics", logsUrl: "http://127.0.0.1:9/v1/logs", timeoutMs: 500 }),
    );
    telemetry.recordRunStart("s-5", "z", true);
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
    expect(telemetry.stats().failed).toBe(2);
  });

  it("bounds its queue and its series", async () => {
    const telemetry = createTelemetryFromSettings(settings({ metricsUrl: undefined }));
    for (let i = 0; i < 2_100; i++) telemetry.recordApiError("m", new Error("x"), 1);
    expect(telemetry.stats().dropped).toBe(52);
    await telemetry.shutdown();
    expect(logRecords()).toHaveLength(2_048);
    expect(received.filter((r) => r.path === "/v1/logs")).toHaveLength(4);

    received.length = 0;
    const series = createTelemetryFromSettings(settings({ logsUrl: undefined }));
    for (let i = 0; i < 1_100; i++) {
      series.recordToolCall(
        {
          toolName: `mcp__evil__t${i}`,
          ok: true,
          durationMs: 1,
          errorCode: null,
          permissionDecision: "user_approved",
          args: {},
        },
        "s",
      );
    }
    await series.shutdown();
    expect(Object.keys(metricSeries())).toHaveLength(1_024);
  });
});

describe("what the pipeline derives", () => {
  it("counts lines from edit arguments", () => {
    expect(linesChanged("write_file", { path: "x", content: "one\ntwo\n" })).toEqual({ added: 2, removed: 0 });
    expect(linesChanged("write_file", { path: "x", content: "" })).toEqual({ added: 0, removed: 0 });
    expect(
      linesChanged("apply_patch", {
        edits: [
          { oldString: "keep\nold\nkeep2", newString: "keep\nnew1\nnew2\nkeep2" },
          { oldString: "gone", newString: "" },
          { oldString: 1, newString: "ignored" },
        ],
      }),
    ).toEqual({ added: 2, removed: 2 });
    expect(linesChanged("run_command", { command: "echo" })).toBeUndefined();
    expect(linesChanged("apply_patch", null)).toBeUndefined();
  });

  it("names every permission decision's outcome and source", () => {
    expect(classifyDecision("session_allowlist")).toEqual({ decision: "accept", source: "user_session" });
    expect(classifyDecision("denied_dangerous")).toEqual({ decision: "reject", source: "policy" });
    expect(classifyDecision("not_evaluated")).toBeUndefined();
  });
});

function scriptedProvider(script: Array<ChatResponse | Error>): ChatProvider {
  const next = async (_req: ChatRequest): Promise<ChatResponse> => {
    const step = script.shift();
    if (step === undefined) throw new Error("script exhausted");
    if (step instanceof Error) throw step;
    return step;
  };
  return { model: "fake-model", chat: next, chatStream: (req) => next(req) };
}

describe("telemetry from a real agent run", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "sf-telemetry-run-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it("stays out of the way when it is off", () => {
    const provider = scriptedProvider([]);
    expect(withProviderTelemetry(provider)).toBe(provider);
    expect(activeTelemetry()).toBeUndefined();
  });

  it("records the session, its API requests and its tool calls when the environment enables it", async () => {
    vi.stubEnv("SEEKFORGE_ENABLE_TELEMETRY", "1");
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "x-collector=yes");
    writeFileSync(join(ws, "a.txt"), "alpha\n");
    const usage = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.001 };
    const provider = withProviderTelemetry(
      scriptedProvider([
        {
          content: "",
          toolCalls: [
            {
              id: "c1",
              name: "apply_patch",
              argumentsJson: JSON.stringify({ path: "a.txt", edits: [{ oldString: "alpha", newString: "beta" }] }),
            },
          ],
          usage,
          finishReason: "tool_calls",
        },
        { content: "done", toolCalls: [], usage, finishReason: "stop" },
        { content: "still done", toolCalls: [], usage, finishReason: "stop" },
      ]),
    );
    const agent = createAgentCore({ provider, dispatcher: createDefaultDispatcher(), confirm: async () => true });
    const events: AgentEvent[] = [];
    for await (const event of agent.runTask({ projectPath: ws, task: "edit a", mode: "edit", approvalMode: "auto" })) {
      events.push(event);
    }
    expect(events.at(-1)?.type).toBe("session.completed");
    const created = events.find((e) => e.type === "session.created");
    const sessionId = created?.type === "session.created" ? created.sessionId : "";
    // A later turn of the same session is another prompt, not another session.
    const followUp: AgentEvent[] = [];
    for await (const event of agent.runTask({
      projectPath: ws,
      task: "anything else?",
      mode: "edit",
      approvalMode: "auto",
      resumeSessionId: sessionId,
    })) {
      followUp.push(event);
    }
    expect(followUp.at(-1)?.type).toBe("session.completed");

    await shutdownTelemetry();
    expect(received.every((r) => r.headers["x-collector"] === "yes")).toBe(true);
    const names = logRecords().map((e) => [e["event.name"], e["session.id"]]);
    expect(names).toEqual([
      ["seekforge.user_prompt", sessionId],
      ["seekforge.api_request", sessionId],
      ["seekforge.tool_result", sessionId],
      ["seekforge.api_request", sessionId],
      ["seekforge.user_prompt", sessionId],
      ["seekforge.api_request", sessionId],
    ]);
    expect(metricSeries()).toMatchObject({
      "seekforge.session.count{}": "1",
      "seekforge.token.usage{model=fake-model,type=output}": "15",
      "seekforge.lines_of_code.count{type=added}": "1",
      "seekforge.lines_of_code.count{type=removed}": "1",
      "seekforge.tool.decision{decision=accept,source=mode,tool_name=apply_patch}": "1",
    });
  });

  it("records an API failure without changing it", async () => {
    vi.stubEnv("SEEKFORGE_ENABLE_TELEMETRY", "1");
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
    const failure = new DeepSeekApiError("DeepSeek API error HTTP 401", 401);
    const provider = withProviderTelemetry(scriptedProvider([failure]));
    await expect(provider.chat({ messages: [] })).rejects.toBe(failure);

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      withProviderTelemetry(scriptedProvider([new Error("aborted")])).chat({ messages: [], signal: aborted.signal }),
    ).rejects.toThrow("aborted");

    await shutdownTelemetry();
    expect(logRecords()).toEqual([
      expect.objectContaining({ "event.name": "seekforge.api_error", model: "fake-model", status_code: "401" }),
    ]);
  });
});
