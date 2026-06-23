import { describe, expect, it } from "vitest";
import { truncateHeadTail } from "../../src/tools/text.js";

describe("truncateHeadTail", () => {
  it("returns text unchanged when within budget", () => {
    const r = truncateHeadTail("short", 100);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe("short");
  });

  it("truncates and marks when over budget", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const r = truncateHeadTail(text, 200);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("[truncated");
    expect(r.text.length).toBeLessThan(text.length);
  });

  it("never splits a line: every kept line is whole", () => {
    const text = Array.from({ length: 400 }, (_, i) => `const value_${i} = computeSomething(${i});`).join("\n");
    const r = truncateHeadTail(text, 300);
    const marker = r.text.match(/\n\.\.\. \[truncated \d+ chars\] \.\.\.\n/);
    expect(marker).not.toBeNull();
    const [head, tail] = r.text.split(/\n\.\.\. \[truncated \d+ chars\] \.\.\.\n/);
    // Every kept line on both sides is a complete original line.
    const originals = new Set(text.split("\n"));
    for (const line of head!.split("\n").filter(Boolean)) expect(originals.has(line)).toBe(true);
    for (const line of tail!.split("\n").filter(Boolean)) expect(originals.has(line)).toBe(true);
  });

  it("respects the budget even when maxChars is smaller than the marker", () => {
    const r = truncateHeadTail("x".repeat(500), 8);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(8);
  });

  it("falls back to a char cut when there is no newline in range", () => {
    const text = "x".repeat(1000); // one giant line, no newlines
    const r = truncateHeadTail(text, 200);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("[truncated");
    expect(r.text.startsWith("x")).toBe(true);
  });
});
