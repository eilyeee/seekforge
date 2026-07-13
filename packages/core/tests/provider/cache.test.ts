import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatResponse } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "../../src/provider/index.js";
import { wrapProviderWithCache } from "../../src/provider/cache.js";

const USAGE = { promptTokens: 100, completionTokens: 50, cacheHitTokens: 10, costUsd: 0.02 };
const ZERO = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 };

function response(content: string): ChatResponse {
  return { content, toolCalls: [], usage: USAGE, finishReason: "stop" };
}

function countingProvider(): ChatProvider & { chats: number; streams: number } {
  const p = {
    model: "fake-model",
    chats: 0,
    streams: 0,
    async chat(_req: ChatRequest): Promise<ChatResponse> {
      p.chats++;
      return response(`reply-${p.chats}`);
    },
    async chatStream(_req: ChatRequest, onDelta: (c: string) => void): Promise<ChatResponse> {
      p.streams++;
      onDelta("streamed");
      return response("streamed");
    },
  };
  return p;
}

const req = (text: string): ChatRequest => ({ messages: [{ role: "user", content: text }] });

describe("wrapProviderWithCache", () => {
  let dir: string;
  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), "seekforge-cache-")), "llm-cache");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("miss calls through and writes; hit replays with zeroed usage", async () => {
    const inner = countingProvider();
    const cached = wrapProviderWithCache(inner, dir);

    const first = await cached.chat(req("hello"));
    expect(first.content).toBe("reply-1");
    expect(first.usage).toEqual(USAGE); // real call: real cost
    expect(inner.chats).toBe(1);
    expect(readdirSync(dir)).toHaveLength(1);

    const second = await cached.chat(req("hello"));
    expect(second.content).toBe("reply-1"); // replayed, not reply-2
    expect(second.usage).toEqual(ZERO); // cached replies cost nothing
    expect(inner.chats).toBe(1);
  });

  it("different requests get different cache entries", async () => {
    const inner = countingProvider();
    const cached = wrapProviderWithCache(inner, dir);
    await cached.chat(req("a"));
    await cached.chat(req("b"));
    expect(inner.chats).toBe(2);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it("differing maxTokens / temperature are distinct cache entries", async () => {
    const inner = countingProvider();
    const cached = wrapProviderWithCache(inner, dir);
    const base = req("hello");
    await cached.chat({ ...base, maxTokens: 100 });
    const bigger = await cached.chat({ ...base, maxTokens: 4000 });
    // Must NOT replay the 100-token reply for the 4000-token request.
    expect(bigger.content).toBe("reply-2");
    expect(inner.chats).toBe(2);

    const hot = await cached.chat({ ...base, maxTokens: 100, temperature: 0.9 });
    expect(hot.content).toBe("reply-3");
    expect(inner.chats).toBe(3);
    expect(readdirSync(dir)).toHaveLength(3);
  });

  it("expired entries (past ttl) are re-fetched", async () => {
    const inner = countingProvider();
    const cached = wrapProviderWithCache(inner, dir, { ttlMs: 60_000 });
    await cached.chat(req("hello"));

    // Backdate the entry beyond the ttl.
    const file = join(dir, readdirSync(dir)[0]!);
    const entry = JSON.parse(readFileSync(file, "utf8")) as { ts: number; response: ChatResponse };
    entry.ts = Date.now() - 120_000;
    writeFileSync(file, JSON.stringify(entry));

    const res = await cached.chat(req("hello"));
    expect(inner.chats).toBe(2);
    expect(res.content).toBe("reply-2");
    expect(res.usage).toEqual(USAGE);
  });

  it("corrupt cache entries are ignored (treated as a miss)", async () => {
    const inner = countingProvider();
    const cached = wrapProviderWithCache(inner, dir);
    await cached.chat(req("hello"));
    const file = join(dir, readdirSync(dir)[0]!);
    writeFileSync(file, "{not json!");

    const res = await cached.chat(req("hello"));
    expect(res.content).toBe("reply-2");
    expect(inner.chats).toBe(2);
  });

  it("cache entries with non-finite timestamps are ignored", async () => {
    const inner = countingProvider();
    const cached = wrapProviderWithCache(inner, dir);
    await cached.chat(req("hello"));
    const file = join(dir, readdirSync(dir)[0]!);
    writeFileSync(file, `{"ts":1e999,"response":${JSON.stringify(response("poisoned"))}}`);

    const res = await cached.chat(req("hello"));
    expect(res.content).toBe("reply-2");
    expect(inner.chats).toBe(2);
  });

  it.each([
    ["scalar response", null],
    ["missing response fields", { content: "poisoned" }],
    ["malformed tool call", { ...response("poisoned"), toolCalls: [{}] }],
    ["empty tool name", { ...response("poisoned"), toolCalls: [{ id: "c1", name: "", argumentsJson: "{}" }] }],
    ["invalid finish reason", { ...response("poisoned"), finishReason: "bogus" }],
    ["negative usage", { ...response("poisoned"), usage: { ...USAGE, costUsd: -1 } }],
    ["fractional token usage", { ...response("poisoned"), usage: { ...USAGE, promptTokens: 1.5 } }],
    ["impossible cache usage", { ...response("poisoned"), usage: { ...USAGE, promptTokens: 1, cacheHitTokens: 2 } }],
    ["non-finite usage", { ...response("poisoned"), usage: { ...USAGE, promptTokens: 1e999 } }],
  ])("ignores cached %s", async (_label, poisoned) => {
    const inner = countingProvider();
    const cached = wrapProviderWithCache(inner, dir);
    await cached.chat(req("hello"));
    const file = join(dir, readdirSync(dir)[0]!);
    writeFileSync(file, JSON.stringify({ ts: Date.now(), response: poisoned }));

    expect((await cached.chat(req("hello"))).content).toBe("reply-2");
    expect(inner.chats).toBe(2);
  });

  it("never caches chatStream — always passes through with live deltas", async () => {
    const inner = countingProvider();
    const cached = wrapProviderWithCache(inner, dir);
    const deltas: string[] = [];

    await cached.chatStream(req("hello"), (c) => deltas.push(c));
    await cached.chatStream(req("hello"), (c) => deltas.push(c));

    expect(inner.streams).toBe(2);
    expect(deltas).toEqual(["streamed", "streamed"]);
    // Streaming writes nothing into the cache dir (it may not even exist).
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      // dir never created — equally fine
    }
    expect(entries).toHaveLength(0);
  });

  it("does not serve or pass through an already-cancelled request", async () => {
    const inner = countingProvider();
    const cached = wrapProviderWithCache(inner, dir);
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    const cancelled = { ...req("hello"), signal: controller.signal };

    await expect(cached.chat(cancelled)).rejects.toBe(reason);
    await expect(cached.chatStream(cancelled, () => {})).rejects.toBe(reason);
    expect(inner.chats).toBe(0);
    expect(inner.streams).toBe(0);
  });

  it("keeps the wrapped provider's model id", () => {
    expect(wrapProviderWithCache(countingProvider(), dir).model).toBe("fake-model");
  });
});
