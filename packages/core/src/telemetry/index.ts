/**
 * OpenTelemetry export (opt-in, OTLP/HTTP JSON, no dependencies).
 *
 * One process-wide pipeline, created the first time something asks for it and
 * only when SEEKFORGE_ENABLE_TELEMETRY is set. It is fed from three places,
 * which between them see every run on every surface:
 *   - `withProviderTelemetry` around each provider core builds (API requests,
 *     errors, tokens, cost);
 *   - the agent loop's event tee (sessions, prompts, active time);
 *   - the loop's per-tool-call audit record (tool results, permission
 *     decisions, lines changed).
 *
 * The pipeline flushes on beforeExit/SIGINT/SIGTERM. A frontend that ends the
 * process with process.exit() must `await shutdownTelemetry()` first, or the
 * last few seconds of records are lost.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { arch, platform, release } from "node:os";
import type { ChatResponse } from "@seekforge/shared";
import type { ChatProvider } from "../provider/types.js";
import { installProcessTeardown } from "../util/process-teardown.js";
import { SEEKFORGE_VERSION } from "../version.js";
import { redactEndpoint, resolveTelemetrySettings, type TelemetrySettings } from "./config.js";
import { createTelemetry, type Telemetry, type ToolCallRecord } from "./telemetry.js";

export { resolveTelemetrySettings, type TelemetryResolution, type TelemetrySettings } from "./config.js";
export {
  classifyDecision,
  createTelemetry,
  linesChanged,
  type Telemetry,
  type TelemetryStats,
  type ToolCallRecord,
} from "./telemetry.js";

let active: Telemetry | null | undefined;
let warnings: string[] = [];
let disposeTeardown: (() => void) | undefined;
const sessionScope = new AsyncLocalStorage<string>();

function defaultResource(): Record<string, string> {
  return {
    "service.name": "seekforge",
    "service.version": SEEKFORGE_VERSION,
    "os.type": platform(),
    "os.version": release(),
    "host.arch": arch(),
  };
}

export function createTelemetryFromSettings(settings: TelemetrySettings, fetchImpl?: typeof fetch): Telemetry {
  return createTelemetry({
    settings,
    defaultResource: defaultResource(),
    scope: { name: "seekforge", version: SEEKFORGE_VERSION },
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/** The pipeline, or undefined when telemetry is off. Resolved from the environment once per process. */
export function activeTelemetry(): Telemetry | undefined {
  if (active === undefined) {
    const resolution = resolveTelemetrySettings(process.env);
    warnings = resolution.warnings;
    active = resolution.enabled ? createTelemetryFromSettings(resolution.settings) : null;
    if (active) {
      const pipeline = active;
      disposeTeardown = installProcessTeardown({ onSignal: () => void pipeline.shutdown() });
    }
  }
  return active ?? undefined;
}

/** Export what is pending and stop. Safe to call when telemetry is off, and more than once. */
export async function shutdownTelemetry(): Promise<void> {
  await active?.shutdown();
}

/** Run `fn` with API requests it makes attributed to `sessionId`. */
export function withTelemetrySession<T>(sessionId: string, fn: () => T): T {
  return activeTelemetry() ? sessionScope.run(sessionId, fn) : fn();
}

/**
 * The agent loop's event tee. Every run emits `session.created`, including
 * each later turn of a resumed session; only a fresh one counts as a session.
 */
export function observeSessionEvent(
  event: { type: string },
  context: { sessionId: string; depth: number; task: string; resumed: boolean },
): void {
  // Nested subagent runs are part of the top-level session's work, not sessions of their own.
  if (context.depth !== 0) return;
  const telemetry = activeTelemetry();
  if (!telemetry) return;
  if (event.type === "session.created") {
    telemetry.recordRunStart(context.sessionId, context.task, !context.resumed);
  } else if (event.type === "session.completed" || event.type === "session.failed") {
    telemetry.recordRunEnd(context.sessionId);
  }
}

/**
 * The agent loop's per-tool-call tee, fed the dispatcher's audit record (every
 * depth: a subagent's edit is still an edit).
 */
export function observeToolCall(entry: Record<string, unknown>, sessionId: string): void {
  const telemetry = activeTelemetry();
  if (!telemetry || typeof entry["toolName"] !== "string") return;
  const call: ToolCallRecord = {
    toolName: entry["toolName"],
    ok: entry["ok"] === true,
    durationMs: typeof entry["durationMs"] === "number" ? entry["durationMs"] : 0,
    errorCode: typeof entry["errorCode"] === "string" ? entry["errorCode"] : null,
    permissionDecision: typeof entry["permissionDecision"] === "string" ? entry["permissionDecision"] : "not_evaluated",
    args: entry["args"],
  };
  telemetry.recordToolCall(call, sessionId);
}

/**
 * The provider, recording each request it serves. Returned unchanged when
 * telemetry is off, so the default path allocates nothing.
 */
export function withProviderTelemetry(provider: ChatProvider): ChatProvider {
  const telemetry = activeTelemetry();
  if (!telemetry) return provider;
  const observe = async (signal: AbortSignal | undefined, run: () => Promise<ChatResponse>): Promise<ChatResponse> => {
    const started = Date.now();
    const sessionId = sessionScope.getStore();
    try {
      const response = await run();
      telemetry.recordApiRequest(provider.model, response.usage, Date.now() - started, sessionId);
      return response;
    } catch (error) {
      // A cancellation is the user's doing, not an API failure.
      if (!signal?.aborted) telemetry.recordApiError(provider.model, error, Date.now() - started, sessionId);
      throw error;
    }
  };
  return {
    model: provider.model,
    ...(provider.cacheIdentity !== undefined ? { cacheIdentity: provider.cacheIdentity } : {}),
    ...(provider.structuredOutput !== undefined ? { structuredOutput: provider.structuredOutput } : {}),
    chat: (req) => observe(req.signal, () => provider.chat(req)),
    chatStream: (req, onDelta, onReasoningDelta) =>
      observe(req.signal, () => provider.chatStream(req, onDelta, onReasoningDelta)),
  };
}

/**
 * One line for `doctor`: whether export is on, where it goes (without
 * credentials), and why it is off when it was asked for.
 */
export function describeTelemetry(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  detail: string;
  warnings: string[];
} {
  const resolution = resolveTelemetrySettings(env);
  if (!resolution.enabled) {
    return {
      enabled: false,
      detail: resolution.warnings.length > 0 ? "requested but off" : "off (set SEEKFORGE_ENABLE_TELEMETRY=1 to export)",
      warnings: resolution.warnings,
    };
  }
  const { metricsUrl, logsUrl } = resolution.settings;
  const targets = [
    metricsUrl ? `metrics → ${redactEndpoint(metricsUrl)}` : undefined,
    logsUrl ? `logs → ${redactEndpoint(logsUrl)}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return { enabled: true, detail: `OTLP http/json: ${targets.join(", ")}`, warnings: resolution.warnings };
}

/** Warnings from resolving the active pipeline (empty until something asked for it). */
export function telemetryWarnings(): readonly string[] {
  return warnings;
}

/** Forget the process-wide pipeline so the next call re-reads the environment (tests). */
export async function resetTelemetryForTests(): Promise<void> {
  disposeTeardown?.();
  disposeTeardown = undefined;
  const previous = active;
  active = undefined;
  warnings = [];
  await previous?.shutdown();
}
