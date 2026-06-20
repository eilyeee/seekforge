import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@seekforge/shared";
import {
  clearOldToolResults,
  compactMessages,
  estimateMessagesTokens,
  estimateTokens,
  llmCompactMessages,
  llmCompactSessionNow,
  type SummaryProvider,
} from "../../src/agent/context.js";
import { createSessionTrace, loadSessionMessages, newSessionId } from "../../src/agent/trace.js";

function msg(role: ChatMessage["role"], content: string, extra?: Partial<ChatMessage>): ChatMessage {
  return { role, content, ...extra };
}

function conversation(turns: number, contentSize = 2000): ChatMessage[] {
  const messages: ChatMessage[] = [msg("system", "system prompt"), msg("user", "the task")];
  for (let i = 0; i < turns; i++) {
    messages.push(
      msg("assistant", "", { toolCalls: [{ id: `c${i}`, name: "read_file", argumentsJson: "{}" }] }),
      msg("tool", "x".repeat(contentSize), { toolCallId: `c${i}` }),
    );
  }
  return messages;
}

describe("estimateTokens", () => {
  it("keeps the ~4-chars-per-token rate for ASCII text", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(40))).toBe(10); // 40 / 4
    expect(estimateTokens("hello world")).toBe(Math.ceil(11 / 4)); // unchanged heuristic
  });

  it("counts CJK characters at ~1 token each, far above length/4", () => {
    const ten = "你好世界今天天气很好"; // 10 Chinese chars
    expect(ten.length).toBe(10);
    // Old length/4 would give 3; the CJK-aware estimate is ~10.
    expect(estimateTokens(ten)).toBe(10);
    expect(estimateTokens(ten)).toBeGreaterThan(Math.ceil(ten.length / 4));
    // Japanese kana and Korean Hangul count the same way.
    expect(estimateTokens("ひらがなカタカナ")).toBe(8);
    expect(estimateTokens("안녕하세요")).toBe(5);
  });

  it("mixes CJK and ASCII additively", () => {
    // 5 Chinese chars (5 tokens) + 8 ASCII chars (ceil(8/4)=2 tokens).
    expect(estimateTokens("你好世界呀: abcdefgh")).toBe(5 + Math.ceil(9 / 4));
  });

  it("is monotonic — appending never lowers the estimate", () => {
    const base = "function foo() { return 42; }";
    expect(estimateTokens(base + "你")).toBeGreaterThanOrEqual(estimateTokens(base));
    expect(estimateTokens(base + "x")).toBeGreaterThanOrEqual(estimateTokens(base));
  });

  it("estimateMessagesTokens reflects the CJK-aware estimate", () => {
    const cjk = estimateMessagesTokens([msg("user", "你好世界今天天气很好")]);
    const ascii = estimateMessagesTokens([msg("user", "0123456789")]); // 10 ASCII chars
    // Same character count, but CJK content costs materially more tokens.
    expect(cjk).toBeGreaterThan(ascii);
  });
});

describe("compactMessages", () => {
  it("returns null when under budget", () => {
    expect(compactMessages(conversation(2), 1_000_000)).toBeNull();
  });

  it("compacts an over-budget conversation below the original size", () => {
    const messages = conversation(30);
    const before = estimateMessagesTokens(messages);
    const result = compactMessages(messages, Math.floor(before / 3));
    expect(result).not.toBeNull();
    expect(estimateMessagesTokens(result!.messages)).toBeLessThan(before);
    expect(result!.droppedTurns).toBeGreaterThan(0);
  });

  it("keeps system prompt and original task at the head", () => {
    const messages = conversation(30);
    const result = compactMessages(messages, 2000)!;
    expect(result.messages[0]!.content).toBe("system prompt");
    expect(result.messages[1]!.content).toBe("the task");
    expect(result.messages[2]!.content).toContain("compacted");
  });

  it("never starts the kept tail on a dangling tool message", () => {
    const messages = conversation(30);
    const result = compactMessages(messages, 2000)!;
    // The first message after the digest must not be a tool result whose
    // assistant tool_calls message was dropped.
    expect(result.messages[3]!.role).not.toBe("tool");
  });
});

describe("llmCompactMessages", () => {
  /** Provider stub recording the summarization requests it receives. */
  function summaryProvider(content: string): SummaryProvider & { requests: ChatMessage[][] } {
    const requests: ChatMessage[][] = [];
    return {
      requests,
      chat: async (req) => {
        requests.push(req.messages);
        return { content };
      },
    };
  }

  it("returns null when under budget without calling the provider", async () => {
    const provider = summaryProvider("never used");
    expect(await llmCompactMessages(provider, conversation(2), 1_000_000)).toBeNull();
    expect(provider.requests).toHaveLength(0);
  });

  it("returns null when the conversation is too short to compact", async () => {
    const provider = summaryProvider("never used");
    // Over budget but <= KEEP_HEAD + KEEP_TAIL + 1 messages: mechanical
    // compactMessages would refuse too.
    const short = conversation(4); // 2 head + 8 turn messages = 10 total
    expect(compactMessages(short, 10)).toBeNull();
    expect(await llmCompactMessages(provider, short, 10)).toBeNull();
    expect(provider.requests).toHaveLength(0);
  });

  it("replaces the dropped middle with the model summary in the digest wrapper", async () => {
    const provider = summaryProvider("Refactored auth.ts; tests green; TODO: docs.");
    const messages = conversation(30);
    const result = await llmCompactMessages(provider, messages, 2000);
    expect(result).not.toBeNull();
    // Same boundary math as the mechanical path.
    const mechanical = compactMessages(messages, 2000)!;
    expect(result!.droppedTurns).toBe(mechanical.droppedTurns);
    expect(result!.messages).toHaveLength(mechanical.messages.length);
    // Head intact, summary wrapped like the mechanical digest, tail aligned.
    expect(result!.messages[0]!.content).toBe("system prompt");
    expect(result!.messages[1]!.content).toBe("the task");
    expect(result!.messages[2]!.role).toBe("user");
    expect(result!.messages[2]!.content).toContain("[Context compacted to fit the window.");
    expect(result!.messages[2]!.content).toContain("Refactored auth.ts; tests green; TODO: docs.");
    expect(result!.messages[3]!.role).not.toBe("tool");
    expect(result!.summaryTokens).toBeGreaterThan(0);
  });

  it("sends a role-prefixed segment with tool results truncated to 200 chars", async () => {
    const provider = summaryProvider("summary");
    await llmCompactMessages(provider, conversation(30, 5000), 2000);
    expect(provider.requests).toHaveLength(1);
    const sent = provider.requests[0]!;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.role).toBe("user");
    expect(sent[0]!.content).toContain("Summarize this conversation segment for an AI coding agent");
    expect(sent[0]!.content).toContain("assistant [tools: read_file]:");
    // 5000-char tool outputs must arrive truncated, total input capped.
    expect(sent[0]!.content).not.toContain("x".repeat(201));
    expect(sent[0]!.content).toContain("x".repeat(200));
    expect(sent[0]!.content.length).toBeLessThanOrEqual(25_000);
  });

  it("puts the focus into the summarization prompt when provided", async () => {
    const provider = summaryProvider("summary");
    await llmCompactMessages(provider, conversation(30), 2000, { focus: "the auth refactor" });
    expect(provider.requests).toHaveLength(1);
    const sent = provider.requests[0]!;
    expect(sent[0]!.content).toContain("Focus especially on: the auth refactor.");
  });

  it("omits the focus phrase when focus is empty/absent", async () => {
    const provider = summaryProvider("summary");
    await llmCompactMessages(provider, conversation(30), 2000, { focus: "   " });
    expect(provider.requests[0]![0]!.content).not.toContain("Focus especially on");
    const provider2 = summaryProvider("summary");
    await llmCompactMessages(provider2, conversation(30), 2000);
    expect(provider2.requests[0]![0]!.content).not.toContain("Focus especially on");
  });

  it("returns null when the provider throws (caller falls back to mechanical)", async () => {
    const provider: SummaryProvider = {
      chat: async () => {
        throw new Error("rate limited");
      },
    };
    expect(await llmCompactMessages(provider, conversation(30), 2000)).toBeNull();
  });

  it("returns null on an empty summary", async () => {
    expect(await llmCompactMessages(summaryProvider("   "), conversation(30), 2000)).toBeNull();
  });
});

describe("clearOldToolResults", () => {
  const GENERIC = '{"ok":true,"note":"[old tool output cleared to save context]"}';

  /**
   * system + N user turns, each turn: user, assistant(toolCall), tool(content).
   * Each call carries a `path` arg so cleared notes can name the source.
   */
  function multiTurn(turns: number, toolContentSize = 1000): ChatMessage[] {
    const messages: ChatMessage[] = [msg("system", "system prompt")];
    for (let i = 0; i < turns; i++) {
      messages.push(
        msg("user", `turn ${i}`),
        msg("assistant", "", {
          toolCalls: [{ id: `c${i}`, name: "read_file", argumentsJson: `{"path":"src/file${i}.ts"}` }],
        }),
        msg("tool", "x".repeat(toolContentSize), { toolCallId: `c${i}` }),
      );
    }
    return messages;
  }

  it("clears only tool results older than the last 2 user turns (default)", () => {
    const messages = multiTurn(4);
    const { messages: out, cleared } = clearOldToolResults(messages);
    // Turns 0 and 1 are older than the last 2 user turns (turns 2 and 3).
    expect(cleared).toBe(2);
    expect(out[3]!.content).toContain("[old read_file output for src/file0.ts cleared"); // turn 0 tool
    expect(out[6]!.content).toContain("[old read_file output for src/file1.ts cleared"); // turn 1 tool
    expect(out[9]!.content).toBe("x".repeat(1000)); // turn 2 tool kept
    expect(out[12]!.content).toBe("x".repeat(1000)); // turn 3 tool kept
    // Non-tool messages and toolCallId pairing are untouched.
    expect(out[3]!.toolCallId).toBe("c0");
    expect(out.map((m) => m.role)).toEqual(messages.map((m) => m.role));
  });

  it("names the source tool + key arg in the cleared note", () => {
    const messages: ChatMessage[] = [
      msg("system", "system prompt"),
      msg("user", "turn 0"),
      msg("assistant", "", {
        toolCalls: [{ id: "g0", name: "run_command", argumentsJson: '{"command":"pnpm test"}' }],
      }),
      msg("tool", "y".repeat(1000), { toolCallId: "g0" }),
      msg("user", "turn 1"),
      msg("user", "turn 2"),
    ];
    const { messages: out, cleared } = clearOldToolResults(messages);
    expect(cleared).toBe(1);
    const note = JSON.parse(out[3]!.content) as { ok: boolean; note: string };
    expect(note.ok).toBe(true);
    expect(note.note).toBe("[old run_command output for pnpm test cleared — re-run if you need it]");
  });

  it("falls back to a name-only note when no key arg is present", () => {
    const messages: ChatMessage[] = [
      msg("system", "system prompt"),
      msg("user", "turn 0"),
      msg("assistant", "", { toolCalls: [{ id: "g0", name: "git_status", argumentsJson: "{}" }] }),
      msg("tool", "z".repeat(1000), { toolCallId: "g0" }),
      msg("user", "turn 1"),
      msg("user", "turn 2"),
    ];
    const out = clearOldToolResults(messages).messages;
    expect(out[3]!.content).toBe(
      JSON.stringify({ ok: true, note: "[old git_status output cleared — re-run if you need it]" }),
    );
  });

  it("uses the generic note when the tool message has no linkage", () => {
    const messages: ChatMessage[] = [
      msg("system", "system prompt"),
      msg("user", "turn 0"),
      msg("assistant", ""), // no toolCalls
      msg("tool", "z".repeat(1000)), // no toolCallId → unmappable
      msg("user", "turn 1"),
      msg("user", "turn 2"),
    ];
    const out = clearOldToolResults(messages).messages;
    expect(out[3]!.content).toBe(GENERIC);
  });

  it("keeps the source-aware note below the idempotency threshold", () => {
    const longPath = `src/${"deep/".repeat(40)}thing.ts`; // > 80 chars, gets truncated
    const messages: ChatMessage[] = [
      msg("system", "system prompt"),
      msg("user", "turn 0"),
      msg("assistant", "", {
        toolCalls: [{ id: "g0", name: "read_file", argumentsJson: JSON.stringify({ path: longPath }) }],
      }),
      msg("tool", "z".repeat(1000), { toolCallId: "g0" }),
      msg("user", "turn 1"),
      msg("user", "turn 2"),
    ];
    const out = clearOldToolResults(messages).messages;
    expect(out[3]!.content.length).toBeLessThan(200);
    // Re-running does not re-clear the already-short note.
    expect(clearOldToolResults(out).cleared).toBe(0);
  });

  it("honors a custom keepLastTurns", () => {
    const { cleared } = clearOldToolResults(multiTurn(4), 1);
    expect(cleared).toBe(3); // everything before the last user turn
    expect(clearOldToolResults(multiTurn(4), 4).cleared).toBe(0);
  });

  it("clears nothing when there are fewer user turns than keepLastTurns", () => {
    const messages = multiTurn(2);
    const res = clearOldToolResults(messages); // exactly 2 turns: nothing is older
    expect(res.cleared).toBe(0);
    expect(res.messages).toBe(messages); // same array back, no copy churn
  });

  it("skips short tool outputs (<= 200 chars)", () => {
    const messages = multiTurn(4, 200);
    expect(clearOldToolResults(messages).cleared).toBe(0);
  });

  it("is pure and idempotent", () => {
    const messages = multiTurn(4);
    const originalContent = messages[3]!.content;
    const first = clearOldToolResults(messages);
    expect(messages[3]!.content).toBe(originalContent); // input untouched
    const second = clearOldToolResults(first.messages);
    expect(second.cleared).toBe(0); // the note is below the threshold
    expect(second.messages).toBe(first.messages);
  });
});

describe("llmCompactSessionNow", () => {
  function fakeProvider(content: string): SummaryProvider & { requests: ChatMessage[][] } {
    const requests: ChatMessage[][] = [];
    return {
      requests,
      chat: async (req) => {
        requests.push(req.messages);
        return { content };
      },
    };
  }

  function writeSession(messages: ChatMessage[]): { workspace: string; sessionId: string } {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-compact-"));
    const sessionId = newSessionId();
    const trace = createSessionTrace(workspace, sessionId);
    for (const m of messages) trace.message(m);
    return { workspace, sessionId };
  }

  it("round-trips: rewrites the stored session with the model summary", async () => {
    const { workspace, sessionId } = writeSession(conversation(30));
    const provider = fakeProvider("Dense session summary.");
    const result = await llmCompactSessionNow(workspace, sessionId, provider, "the parser fix");
    expect(result).not.toBeNull();
    expect(result!.droppedTurns).toBeGreaterThan(0);
    expect(result!.afterTokens).toBeLessThan(result!.beforeTokens);
    // Focus reaches the provider prompt.
    expect(provider.requests[0]![0]!.content).toContain("Focus especially on: the parser fix.");
    // The stored history is now compacted and replays the summary.
    const reloaded = loadSessionMessages(workspace, sessionId);
    expect(reloaded.some((m) => m.content.includes("Dense session summary."))).toBe(true);
    expect(reloaded.length).toBeLessThan(conversation(30).length);
  });

  it("returns null for a missing session (no messages file)", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-compact-"));
    const provider = fakeProvider("never");
    expect(await llmCompactSessionNow(workspace, "does-not-exist", provider)).toBeNull();
    expect(provider.requests).toHaveLength(0);
  });

  it("returns null on a too-short session without rewriting", async () => {
    const { workspace, sessionId } = writeSession(conversation(2));
    const provider = fakeProvider("never");
    expect(await llmCompactSessionNow(workspace, sessionId, provider)).toBeNull();
    expect(provider.requests).toHaveLength(0);
    // Untouched.
    expect(loadSessionMessages(workspace, sessionId)).toHaveLength(conversation(2).length);
  });
});
