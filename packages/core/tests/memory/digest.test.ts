import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@seekforge/shared";
import { buildTranscriptDigest } from "../../src/memory/extract.js";

const DIGEST_MAX_CHARS = 6000;

function digestChars(s: string): number {
  return s.length;
}

describe("buildTranscriptDigest", () => {
  it("keeps every line in chronological order when under budget", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "reading files" },
      { role: "tool", content: "result", toolCallId: "c1" },
      { role: "assistant", content: "done" },
    ];
    const out = buildTranscriptDigest(messages);
    expect(out).toBe("user: do the thing\nassistant: reading files\ntool: result\nassistant: done");
  });

  it("stays within the char budget for long sessions", () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 500; i++) {
      messages.push({ role: "assistant", content: `filler line number ${i} ${"x".repeat(150)}` });
    }
    const out = buildTranscriptDigest(messages);
    expect(digestChars(out)).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
  });

  it("keeps BOTH the head (task) and the tail (recent turns) of a long session", () => {
    const messages: ChatMessage[] = [];
    messages.push({ role: "user", content: "HEAD_TASK implement the parser" });
    for (let i = 0; i < 400; i++) {
      messages.push({ role: "assistant", content: `middle filler ${i} ${"y".repeat(150)}` });
    }
    messages.push({ role: "assistant", content: "TAIL_DONE finished and verified" });
    const out = buildTranscriptDigest(messages);
    expect(out).toContain("HEAD_TASK implement the parser");
    expect(out).toContain("TAIL_DONE finished and verified");
    expect(digestChars(out)).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
  });

  it("prioritizes signal-carrying middle lines over filler when over budget", () => {
    const messages: ChatMessage[] = [];
    messages.push({ role: "user", content: "HEAD start" });
    // Lots of filler, plus one buried decision/error line.
    for (let i = 0; i < 100; i++) {
      messages.push({ role: "assistant", content: `plain narration step ${i} ${"z".repeat(150)}` });
    }
    messages.push({
      role: "tool",
      content: "ERROR: build failed because DATABASE_URL was not set; fixed by exporting it",
    });
    for (let i = 0; i < 100; i++) {
      messages.push({ role: "assistant", content: `more plain narration step ${i} ${"z".repeat(150)}` });
    }
    messages.push({ role: "assistant", content: "TAIL end" });
    const out = buildTranscriptDigest(messages);
    expect(out).toContain("HEAD start");
    expect(out).toContain("TAIL end");
    // The buried signal line beats the filler around it.
    expect(out).toContain("ERROR: build failed because DATABASE_URL");
    expect(digestChars(out)).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
  });

  it("is deterministic (same input -> identical output)", () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 300; i++) {
      messages.push({ role: "assistant", content: `line ${i} ${i % 7 === 0 ? "error here" : "filler"} ${"q".repeat(120)}` });
    }
    expect(buildTranscriptDigest(messages)).toBe(buildTranscriptDigest(messages));
  });

  it("preserves chronological order of kept lines", () => {
    const messages: ChatMessage[] = [];
    messages.push({ role: "user", content: "AAA head marker" });
    for (let i = 0; i < 300; i++) {
      messages.push({ role: "assistant", content: `mid ${i} ${"w".repeat(150)}` });
    }
    messages.push({ role: "assistant", content: "ZZZ tail marker" });
    const out = buildTranscriptDigest(messages);
    expect(out.indexOf("AAA head marker")).toBeLessThan(out.indexOf("ZZZ tail marker"));
  });
});
