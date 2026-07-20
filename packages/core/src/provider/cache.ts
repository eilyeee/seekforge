import * as crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import type { ChatResponse } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "./types.js";
import { isRecord } from "../util/guards.js";
import {
  readWorkspaceStateFile,
  WorkspaceStateTooLargeError,
  writeWorkspaceStateFileAtomic,
} from "../util/workspace-state.js";
import { MAX_PROVIDER_USAGE_TOKENS } from "./mapping.js";
import {
  MAX_PROVIDER_RESPONSE_BYTES,
  MAX_SSE_CONTENT_CHARS,
  MAX_SSE_REASONING_CHARS,
  MAX_SSE_TOOL_ARGUMENT_CHARS,
  MAX_SSE_TOOL_CALLS,
  MAX_SSE_TOTAL_TOOL_ARGUMENT_CHARS,
} from "./protocol-limits.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type ProviderCacheOptions = {
  /** Entry freshness window in milliseconds (default 24h). */
  ttlMs?: number;
};

type CacheEntry = {
  /** Epoch milliseconds when the entry was written. */
  ts: number;
  response: ChatResponse;
};

const FINISH_REASONS = new Set(["stop", "tool_calls", "length", "other"]);
const isTokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_PROVIDER_USAGE_TOKENS;
const isFiniteNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function parseChatResponse(value: unknown): ChatResponse | null {
  if (!isRecord(value) || typeof value["content"] !== "string" || value["content"].length > MAX_SSE_CONTENT_CHARS)
    return null;
  const toolCalls = value["toolCalls"];
  let totalArgumentChars = 0;
  if (
    !Array.isArray(toolCalls) ||
    toolCalls.length > MAX_SSE_TOOL_CALLS ||
    !toolCalls.every(
      (call) =>
        isRecord(call) &&
        typeof call["id"] === "string" &&
        call["id"].length > 0 &&
        typeof call["name"] === "string" &&
        call["name"].length > 0 &&
        typeof call["argumentsJson"] === "string" &&
        call["argumentsJson"].length <= MAX_SSE_TOOL_ARGUMENT_CHARS &&
        (totalArgumentChars += call["argumentsJson"].length) <= MAX_SSE_TOTAL_TOOL_ARGUMENT_CHARS,
    )
  ) {
    return null;
  }
  const usage = value["usage"];
  if (
    !isRecord(usage) ||
    !["promptTokens", "completionTokens", "cacheHitTokens"].every((key) => isTokenCount(usage[key])) ||
    !isFiniteNonnegative(usage["costUsd"]) ||
    (usage["cacheHitTokens"] as number) > (usage["promptTokens"] as number)
  ) {
    return null;
  }
  if (
    typeof value["finishReason"] !== "string" ||
    !FINISH_REASONS.has(value["finishReason"]) ||
    (value["reasoningContent"] !== undefined &&
      (typeof value["reasoningContent"] !== "string" || value["reasoningContent"].length > MAX_SSE_REASONING_CHARS))
  ) {
    return null;
  }
  return value as ChatResponse;
}

/** Cache key: content hash over everything that determines the reply. */
function cacheKey(providerIdentity: string, model: string, req: ChatRequest): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        providerIdentity,
        model,
        messages: req.messages,
        tools: req.tools ?? null,
        temperature: req.temperature ?? null,
        maxTokens: req.maxTokens ?? null,
      }),
    )
    .digest("hex");
}

/**
 * A cached reply cost nothing THIS time: the usage is zeroed so cumulative
 * session cost reflects actual spend, not what the original call cost.
 */
function zeroedUsage(res: ChatResponse): ChatResponse {
  return {
    ...res,
    usage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 },
  };
}

type CacheReadResult =
  | { kind: "hit"; response: ChatResponse }
  | { kind: "missing" | "stale" }
  | { kind: "corrupt" | "too_large" | "unsafe" };

/**
 * Wraps a ChatProvider with a file-based response cache under `dir`.
 *
 * chat(): the provider identity and request (model + messages + tools) are hashed to
 * `<dir>/<sha256>.json`; a fresh entry (within ttlMs, default 24h) is
 * returned directly with zeroed usage (replaying a cached reply costs
 * nothing). On a miss the call goes through and the response is written
 * best-effort — cache IO failures and corrupt entries are silently ignored
 * and never fail the underlying call.
 *
 * chatStream(): NEVER cached, always passed through. Streaming's value is
 * the live onDelta/onReasoningDelta callbacks; replaying a stored response
 * would either skip them or fake incremental delivery, so streaming runs
 * (interactive TUI sessions) intentionally bypass the cache.
 */
export function wrapProviderWithCache(provider: ChatProvider, dir: string, opts?: ProviderCacheOptions): ChatProvider {
  const configuredTtl = opts?.ttlMs;
  const ttlMs =
    typeof configuredTtl === "number" && Number.isFinite(configuredTtl) && configuredTtl >= 0
      ? Math.min(Math.floor(configuredTtl), Number.MAX_SAFE_INTEGER)
      : DEFAULT_TTL_MS;

  function read(key: string): CacheReadResult {
    try {
      const raw = readWorkspaceStateFile(dir, `${key}.json`, MAX_PROVIDER_RESPONSE_BYTES);
      if (raw === undefined) return { kind: "missing" };
      let entry: unknown;
      try {
        entry = JSON.parse(raw) as unknown;
      } catch {
        return { kind: "corrupt" };
      }
      if (!isRecord(entry)) return { kind: "corrupt" };
      const timestamp = entry["ts"];
      if (!Number.isSafeInteger(timestamp) || (timestamp as number) < 0) {
        return { kind: "corrupt" };
      }
      const age = Date.now() - (timestamp as number);
      if (age < -MAX_FUTURE_CLOCK_SKEW_MS) return { kind: "corrupt" };
      if (age > ttlMs) return { kind: "stale" };
      const response = parseChatResponse(entry["response"]);
      return response ? { kind: "hit", response } : { kind: "corrupt" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
      if (error instanceof WorkspaceStateTooLargeError) return { kind: "too_large" };
      return { kind: "unsafe" };
    }
  }

  function write(key: string, response: ChatResponse): void {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const entry: CacheEntry = { ts: Date.now(), response };
      const serialized = JSON.stringify(entry);
      if (Buffer.byteLength(serialized, "utf8") > MAX_PROVIDER_RESPONSE_BYTES) return;
      writeWorkspaceStateFileAtomic(dir, `${key}.json`, serialized);
    } catch {
      // best-effort: a read-only or full disk must not fail the chat call
    }
  }

  return {
    model: provider.model,
    ...(provider.cacheIdentity !== undefined ? { cacheIdentity: provider.cacheIdentity } : {}),
    async chat(req) {
      if (req.signal?.aborted) throw req.signal.reason;
      const key = cacheKey(provider.cacheIdentity ?? provider.model, provider.model, req);
      const cached = read(key);
      if (cached.kind === "hit") return zeroedUsage(cached.response);
      const res = await provider.chat(req);
      if (req.signal?.aborted) throw req.signal.reason;
      if (cached.kind === "missing" || cached.kind === "stale") write(key, res);
      return res;
    },
    chatStream(req, onDelta, onReasoningDelta) {
      if (req.signal?.aborted) return Promise.reject(req.signal.reason);
      return provider.chatStream(req, onDelta, onReasoningDelta);
    },
  };
}
