import { describe, expect, it } from "vitest";
import type { BgTask, ChatItem } from "../model.js";
import { contextBreakdown, formatBgTaskLines, gauge, gaugeCaption } from "../surfaces.js";

describe("formatBgTaskLines", () => {
  const tasks: BgTask[] = [
    { id: "bg-1", command: "npm run dev", status: "running" },
    { id: "bg-2", command: "sleep   100\nextra", status: "exited" },
  ];

  it("renders gear, id, status, and collapsed command", () => {
    const lines = formatBgTaskLines(tasks);
    expect(lines[0]).toBe("⚙ bg-1  running  npm run dev");
    expect(lines[1]).toBe("⚙ bg-2  exited   sleep 100 extra");
  });

  it("reports an empty list", () => {
    expect(formatBgTaskLines([])).toEqual(["no background tasks this session"]);
  });
});

describe("gauge", () => {
  it("renders an empty bar at 0%", () => {
    expect(gauge(0)).toBe(`${"░".repeat(24)} 0%`);
  });

  it("renders a full bar at 100%", () => {
    expect(gauge(100)).toBe(`${"█".repeat(24)} 100%`);
  });

  it("clamps values above 100 and below 0", () => {
    expect(gauge(150)).toBe(`${"█".repeat(24)} 100%`);
    expect(gauge(-20)).toBe(`${"░".repeat(24)} 0%`);
  });

  it("fills proportionally at the default 24-column width", () => {
    expect(gauge(28)).toBe(`${"█".repeat(7)}${"░".repeat(17)} 28%`);
  });

  it("honors a custom width and rounds fractional percents", () => {
    expect(gauge(50.4, 10)).toBe(`${"█".repeat(5)}${"░".repeat(5)} 50%`);
  });
});

describe("gaugeCaption", () => {
  it("formats used/budget tokens compactly", () => {
    expect(gaugeCaption(28_000, 100_000)).toBe("28.0K of 100.0K tokens");
  });
});

describe("contextBreakdown", () => {
  const items: ChatItem[] = [
    { kind: "user", id: "u1", text: "x".repeat(40) }, // 10 tok
    { kind: "assistant", id: "a1", text: "y".repeat(400), streaming: false }, // 100 tok
    {
      kind: "tool",
      id: "t1",
      toolName: "read_file",
      args: { path: "src/index.ts" },
      status: "ok",
      resultPreview: "z".repeat(800),
    },
    { kind: "shell", id: "sh1", command: "ls", output: "a\nb\nc", exitCode: 0 },
    { kind: "step", id: "s1", title: "step title is excluded" },
    { kind: "notice", id: "n1", text: "local notice is excluded", tone: "dim" },
  ];

  it("groups items into categories with chars/4 estimates, sorted by tokens", () => {
    const rows = contextBreakdown(items);
    expect(rows.map((r) => r.label)).toEqual(["tool results", "assistant text", "user messages", "shell output"]);
    const tool = rows[0]!;
    // read_file + args JSON + 800-char preview, chars/4
    expect(tool.tokens).toBeGreaterThan(200);
    expect(tool.count).toBe(1);
    const assistant = rows[1]!;
    expect(assistant.tokens).toBe(100);
  });

  it("percents are shares of the total and sum to ~100", () => {
    const rows = contextBreakdown(items);
    const sum = rows.reduce((acc, r) => acc + r.percent, 0);
    expect(sum).toBeGreaterThanOrEqual(98);
    expect(sum).toBeLessThanOrEqual(102);
    for (const row of rows) {
      expect(row.percent).toBeGreaterThanOrEqual(0);
      expect(row.percent).toBeLessThanOrEqual(100);
    }
  });

  it("excludes steps and notices and merges same-category items", () => {
    const rows = contextBreakdown([
      { kind: "step", id: "s", title: "only steps" },
      { kind: "notice", id: "n", text: "only notices", tone: "dim" },
      { kind: "user", id: "u1", text: "aaaa" },
      { kind: "user", id: "u2", text: "bbbb" },
    ]);
    expect(rows).toEqual([{ label: "user messages", tokens: 2, count: 2, percent: 100 }]);
  });

  it("groups diffs and file references together", () => {
    const rows = contextBreakdown([
      { kind: "diff", id: "d1", path: "a.ts", lines: [{ kind: "add", text: "+new line" }] },
      { kind: "file", id: "f1", path: "src/very/long/path.ts" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("diffs & files");
    expect(rows[0]!.count).toBe(2);
  });

  it("returns no rows for an empty transcript", () => {
    expect(contextBreakdown([])).toEqual([]);
  });
});
