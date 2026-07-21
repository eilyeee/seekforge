import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createBoundedLineReader } from "../../src/mcp/framing.js";

describe("bounded newline framing", () => {
  it("discards an oversized unterminated frame and resumes after its newline", () => {
    const input = new PassThrough();
    const lines: string[] = [];
    let oversized = 0;
    const reader = createBoundedLineReader(input, {
      maxBytes: 8,
      onLine: (line) => lines.push(line),
      onOversize: () => oversized++,
    });
    input.write("12345");
    input.write("67890");
    input.write("discarded\nok\n");
    expect(oversized).toBe(1);
    expect(lines).toEqual(["ok"]);
    reader.close();
  });

  it("measures bytes rather than UTF-16 characters", () => {
    const input = new PassThrough();
    const lines: string[] = [];
    let oversized = 0;
    createBoundedLineReader(input, {
      maxBytes: 4,
      onLine: (line) => lines.push(line),
      onOversize: () => oversized++,
    });
    input.end("😀x\nnext\n");
    expect(oversized).toBe(1);
    expect(lines).toEqual(["next"]);
  });
});
