import { describe, expect, it } from "vitest";
import { digestCommandOutput, truncateHeadTail } from "../../src/tools/text.js";

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

  it("cuts on construct boundaries when ranges are given (whole functions, not severed)", () => {
    let src = "";
    const ranges: { start: number; end: number }[] = [];
    for (let i = 0; i < 60; i++) {
      const start = src.length;
      src += `function fn${i}() {\n  return ${i};\n}\n`; // multi-line: line-aware could split it
      ranges.push({ start, end: src.length });
    }
    const { text, truncated } = truncateHeadTail(src, 500, { ranges });
    expect(truncated).toBe(true);
    const [head, tail] = text.split(/\n\.\.\. \[truncated \d+ chars\] \.\.\.\n/);
    // head ends at a complete function (closing brace), not mid-function
    expect(head!.trimEnd().endsWith("}")).toBe(true);
    // tail resumes at the start of a function, not mid-body
    expect(tail!.trimStart().startsWith("function fn")).toBe(true);
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

describe("digestCommandOutput", () => {
  it("returns trimmed output unchanged when it fits", () => {
    expect(digestCommandOutput("  all green  ", 100)).toBe("all green");
  });

  it("maps empty output to a placeholder", () => {
    expect(digestCommandOutput("   \n  ", 100)).toBe("(no output)");
  });

  it("surfaces a buried failure line that the head/tail cut would drop", () => {
    const noise = Array.from({ length: 400 }, (_, i) => `ok ${i} passing case`).join("\n");
    // The failing assertion sits in the omitted middle, away from head and tail.
    const output = `${noise}\nAssertionError: expected 1 to be 2\n${noise}`;
    const digest = digestCommandOutput(output, 600);
    expect(digest).toContain("failure lines from the omitted region");
    expect(digest).toContain("AssertionError: expected 1 to be 2");
    // Budget is respected (within a small marker slack).
    expect(digest.length).toBeLessThanOrEqual(700);
  });

  it("falls back to a plain head+tail when nothing looks like a failure", () => {
    const output = Array.from({ length: 400 }, (_, i) => `ok ${i} passing case`).join("\n");
    const digest = digestCommandOutput(output, 400);
    expect(digest).toContain("[truncated");
    expect(digest).not.toContain("failure lines from the omitted region");
  });
});
