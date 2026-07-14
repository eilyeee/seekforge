import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatResponse } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "./types.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

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
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isTokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isFiniteNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function parseChatResponse(value: unknown): ChatResponse | null {
  if (!isRecord(value) || typeof value["content"] !== "string") return null;
  const toolCalls = value["toolCalls"];
  if (!Array.isArray(toolCalls) || !toolCalls.every((call) =>
    isRecord(call) && typeof call["id"] === "string" && call["id"].length > 0 &&
    typeof call["name"] === "string" && call["name"].length > 0 &&
    typeof call["argumentsJson"] === "string")) {
    return null;
  }
  const usage = value["usage"];
  if (!isRecord(usage) ||
      !["promptTokens", "completionTokens", "cacheHitTokens"].every((key) => isTokenCount(usage[key])) ||
      !isFiniteNonnegative(usage["costUsd"]) ||
      (usage["cacheHitTokens"] as number) > (usage["promptTokens"] as number)) {
    return null;
  }
  if (typeof value["finishReason"] !== "string" || !FINISH_REASONS.has(value["finishReason"]) ||
      (value["reasoningContent"] !== undefined && typeof value["reasoningContent"] !== "string")) {
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
export function wrapProviderWithCache(
  provider: ChatProvider,
  dir: string,
  opts?: ProviderCacheOptions,
): ChatProvider {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;

  function read(key: string): ChatResponse | null {
    try {
      const raw = fs.readFileSync(path.join(dir, `${key}.json`), "utf8");
      const entry = JSON.parse(raw) as unknown;
      if (!isRecord(entry) || typeof entry["ts"] !== "number" || !Number.isFinite(entry["ts"])) return null;
      if (Date.now() - entry["ts"] > ttlMs) return null;
      return parseChatResponse(entry["response"]);
    } catch {
      return null; // missing or corrupt entry = miss
    }
  }

  function write(key: string, response: ChatResponse): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const entry: CacheEntry = { ts: Date.now(), response };
      fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(entry));
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
      if (cached) return zeroedUsage(cached);
      const res = await provider.chat(req);
      write(key, res);
      return res;
    },
    chatStream(req, onDelta, onReasoningDelta) {
      if (req.signal?.aborted) return Promise.reject(req.signal.reason);
      return provider.chatStream(req, onDelta, onReasoningDelta);
    },
  };
}
