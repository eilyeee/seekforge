import { describe, expect, it } from "vitest";
import type { DiffLine } from "../model.js";
import {
  TIPS,
  diffStats,
  formatDuration,
  keyHints,
  layoutTable,
  numberDiffLines,
  osc8Link,
  pickTip,
  supportsHyperlinks,
  toolResultSummary,
  toolTitle,
  turnSummaryLine,
} from "../render-helpers.js";

describe("toolTitle", () => {
  it("maps file tools to Read/Write/Update with the path", () => {
    expect(toolTitle("read_file", { path: "src/app.ts" })).toEqual({ verb: "Read", detail: "src/app.ts" });
    expect(toolTitle("write_file", { path: "a.txt", content: "x" })).toEqual({ verb: "Write", detail: "a.txt" });
    expect(toolTitle("apply_patch", { path: "b.ts", edits: [] })).toEqual({ verb: "Update", detail: "b.ts" });
  });

  it("maps list_files with '.' fallback for a missing path", () => {
    expect(toolTitle("list_files", {})).toEqual({ verb: "List", detail: "." });
    expect(toolTitle("list_files", { path: "src" })).toEqual({ verb: "List", detail: "src" });
  });

  it("maps search_text with quoted pattern and optional path", () => {
    expect(toolTitle("search_text", { pattern: "foo" })).toEqual({ verb: "Search", detail: '"foo"' });
    expect(toolTitle("search_text", { pattern: "foo", path: "src" })).toEqual({
      verb: "Search",
      detail: '"foo", path: src',
    });
  });

  it("maps run_command to Bash and marks background runs", () => {
    expect(toolTitle("run_command", { command: "npm test" })).toEqual({ verb: "Bash", detail: "npm test" });
    expect(toolTitle("run_command", { command: "npm run dev", background: true })).toEqual({
      verb: "Bash",
      detail: "npm run dev + background",
    });
  });

  it("maps git/plan/web/task/agent/question tools", () => {
    expect(toolTitle("git_diff", {})).toEqual({ verb: "Diff", detail: "" });
    expect(toolTitle("git_diff", { staged: true })).toEqual({ verb: "Diff", detail: "staged" });
    expect(toolTitle("git_status", {})).toEqual({ verb: "GitStatus", detail: "" });
    expect(toolTitle("update_plan", { items: [] })).toEqual({ verb: "Plan", detail: "" });
    expect(toolTitle("web_search", { query: "ink tables" })).toEqual({ verb: "WebSearch", detail: "ink tables" });
    expect(toolTitle("task_output", { taskId: "t-1" })).toEqual({ verb: "TaskOutput", detail: "t-1" });
    expect(toolTitle("task_kill", { taskId: "t-2" })).toEqual({ verb: "TaskKill", detail: "t-2" });
    expect(toolTitle("agent_result", { dispatchId: "d-1" })).toEqual({ verb: "AgentResult", detail: "d-1" });
    expect(toolTitle("agent_send", { dispatchId: "d-2", task: "more" })).toEqual({ verb: "AgentSend", detail: "d-2" });
    expect(toolTitle("ask_user", { question: "Deploy now?" })).toEqual({ verb: "Question", detail: "Deploy now?" });
  });

  it("maps dispatch_agent to Agent(agentId: first 60 of task)", () => {
    const task = "x".repeat(100);
    const { verb, detail } = toolTitle("dispatch_agent", { agentId: "tester", task });
    expect(verb).toBe("Agent");
    expect(detail.startsWith("tester: ")).toBe(true);
    expect(detail).toContain("…");
  });

  it("maps mcp__server__tool to server:tool with first arg values", () => {
    expect(toolTitle("mcp__github__create_issue", { title: "bug", repo: "a/b" })).toEqual({
      verb: "github:create_issue",
      detail: "bug, a/b",
    });
  });

  it("falls back to raw name + compact JSON for unknown tools", () => {
    const { verb, detail } = toolTitle("mystery_tool", { a: 1 });
    expect(verb).toBe("mystery_tool");
    expect(detail).toBe('{"a":1}');
    expect(toolTitle("mystery_tool", {}).detail).toBe("");
  });

  it("middle-truncates long details to 80 chars", () => {
    const { detail } = toolTitle("read_file", { path: "src/" + "a".repeat(200) + ".ts" });
    expect(detail.length).toBe(80);
    expect(detail).toContain("…");
    expect(detail.startsWith("src/")).toBe(true);
    expect(detail.endsWith(".ts")).toBe(true);
  });

  it("tolerates non-object args", () => {
    expect(toolTitle("read_file", null)).toEqual({ verb: "Read", detail: "" });
    expect(toolTitle("read_file", "weird")).toEqual({ verb: "Read", detail: "" });
  });
});

describe("toolResultSummary", () => {
  it("counts read_file lines from totalLines or content", () => {
    expect(toolResultSummary("read_file", true, JSON.stringify({ path: "a", totalLines: 120 }))).toBe("120 lines");
    expect(toolResultSummary("read_file", true, JSON.stringify({ content: "a\nb\nc" }))).toBe("3 lines");
    expect(toolResultSummary("read_file", true, JSON.stringify({ path: "a" }))).toBeNull();
  });

  it("summarizes run_command exit code and duration", () => {
    expect(toolResultSummary("run_command", true, JSON.stringify({ exitCode: 0, durationMs: 1200 }))).toBe(
      "exit 0 in 1.2s",
    );
    expect(toolResultSummary("run_command", true, JSON.stringify({ exitCode: 2 }))).toBe("exit 2");
    expect(toolResultSummary("run_command", true, JSON.stringify({ taskId: "bg-1" }))).toBe("task bg-1");
  });

  it("counts search matches and list entries (with singular forms)", () => {
    expect(toolResultSummary("search_text", true, JSON.stringify({ count: 2, matches: [{}, {}] }))).toBe("2 matches");
    expect(toolResultSummary("search_text", true, JSON.stringify({ matches: [{}] }))).toBe("1 match");
    expect(toolResultSummary("list_files", true, JSON.stringify({ count: 12 }))).toBe("12 entries");
    expect(toolResultSummary("list_files", true, JSON.stringify({ entries: ["a"] }))).toBe("1 entry");
  });

  it("returns 'ok' for successful writes and patches", () => {
    expect(toolResultSummary("write_file", true)).toBe("ok");
    expect(toolResultSummary("apply_patch", true, JSON.stringify({ editsApplied: 3 }))).toBe("ok");
  });

  it("returns the first 60 chars of a dispatch_agent summary", () => {
    const summary = "did the thing " + "y".repeat(100);
    const out = toolResultSummary("dispatch_agent", true, JSON.stringify({ summary }));
    expect(out?.startsWith("did the thing")).toBe(true);
    expect(out?.endsWith("…")).toBe(true);
    expect(out?.length).toBe(61);
  });

  it("formats errors as 'code: message' capped at 100", () => {
    expect(toolResultSummary("read_file", false, undefined, { code: "not_found", message: "no such file" })).toBe(
      "not_found: no such file",
    );
    const long = toolResultSummary("read_file", false, undefined, { code: "e", message: "m".repeat(200) });
    expect(long?.length).toBe(100);
    expect(long).toContain("…");
    expect(toolResultSummary("read_file", false)).toBeNull();
  });

  it("returns null on truncated/unparseable previews and unknown tools", () => {
    expect(toolResultSummary("read_file", true, '{"content":"a\\nb')).toBeNull(); // truncated JSON
    expect(toolResultSummary("run_command", true, "not json")).toBeNull();
    expect(toolResultSummary("read_file", true)).toBeNull();
    expect(toolResultSummary("git_status", true, JSON.stringify({ status: "" }))).toBeNull();
    expect(toolResultSummary("some_tool", true, "{}")).toBeNull();
  });
});

describe("formatDuration", () => {
  it("uses one decimal under 10s", () => {
    expect(formatDuration(800)).toBe("0.8s");
    expect(formatDuration(0)).toBe("0.0s");
    expect(formatDuration(9_949)).toBe("9.9s");
  });

  it("uses whole seconds from 10s to 60s", () => {
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(59_400)).toBe("59s");
  });

  it("uses m + zero-padded seconds beyond a minute", () => {
    expect(formatDuration(124_000)).toBe("2m04s");
    expect(formatDuration(60_000)).toBe("1m00s");
    expect(formatDuration(59_700)).toBe("1m00s"); // rounds up across the boundary
  });
});

describe("turnSummaryLine", () => {
  it("joins duration, cost, and tokens with middots", () => {
    expect(turnSummaryLine({ durationMs: 34_000, costUsd: 0.0123, totalTokens: 12_400 })).toBe(
      "✓ 34s · $0.0123 · 12.4K tok",
    );
  });

  it("keeps small token counts uncompacted", () => {
    expect(turnSummaryLine({ durationMs: 800, costUsd: 0, totalTokens: 950 })).toBe("✓ 0.8s · $0.0000 · 950 tok");
  });
});

describe("TIPS / pickTip", () => {
  it("has 8-12 single-line tips", () => {
    expect(TIPS.length).toBeGreaterThanOrEqual(8);
    expect(TIPS.length).toBeLessThanOrEqual(12);
    for (const tip of TIPS) expect(tip).not.toContain("\n");
  });

  it("is deterministic with a seed and always returns a known tip", () => {
    expect(pickTip(0)).toBe(TIPS[0]);
    expect(pickTip(TIPS.length + 1)).toBe(TIPS[1]);
    expect(pickTip(-3)).toBe(TIPS[3 % TIPS.length]);
    expect(TIPS).toContain(pickTip());
  });
});

describe("keyHints", () => {
  it("returns context-sensitive hints per mode", () => {
    expect(keyHints("idle")).toBe("⏎ send · / commands · @ files · Ctrl+R history");
    expect(keyHints("running")).toBe("Esc interrupt · Ctrl+B background · ⏎ queue");
    expect(keyHints("permission")).toBe("y allow · a allow session · n deny");
  });
});

describe("diffStats", () => {
  it("counts adds and dels, ignoring context and hunks", () => {
    expect(diffStats([{ kind: "hunk" }, { kind: "add" }, { kind: "add" }, { kind: "del" }, { kind: "ctx" }])).toEqual({
      adds: 2,
      dels: 1,
    });
    expect(diffStats([])).toEqual({ adds: 0, dels: 0 });
  });
});

describe("layoutTable", () => {
  it("aligns columns and bolds nothing itself (pure text)", () => {
    const out = layoutTable(["| name | age |", "|---|---|", "| ada | 36 |", "| bob | 7 |"]);
    expect(out).not.toBeNull();
    const rows = out as string[];
    expect(rows[0]).toBe("name  age");
    expect(rows[1]).toBe("─".repeat(9));
    expect(rows[2]).toBe("ada   36");
    expect(rows[3]).toBe("bob   7");
  });

  it("supports alignment colons and rows without outer pipes", () => {
    const out = layoutTable(["a | b", ":--- | ---:", "1 | 2"]);
    expect(out).not.toBeNull();
    expect((out as string[])[0]).toBe("a  b");
  });

  it("rejects malformed tables", () => {
    expect(layoutTable(["| a | b |"])).toBeNull(); // header only (still streaming)
    expect(layoutTable(["| a | b |", "| not | sep |", "| 1 | 2 |"])).toBeNull();
    expect(layoutTable(["plain text", "|---|"])).toBeNull();
    expect(layoutTable([])).toBeNull();
  });

  it("caps total width at 100 and truncates over-wide cells", () => {
    const wide = "w".repeat(150);
    const out = layoutTable([`| ${wide} | b |`, "|---|---|", "| x | y |"]) as string[];
    expect(out).not.toBeNull();
    for (const row of out) expect(row.length).toBeLessThanOrEqual(100);
    expect(out[0]).toContain("…");
  });

  it("pads missing cells in ragged rows", () => {
    const out = layoutTable(["| a | b | c |", "|---|---|---|", "| 1 |"]) as string[];
    expect(out).not.toBeNull();
    expect(out[2]?.trimEnd()).toBe("1");
  });

  it("aligns columns by terminal width, counting CJK/wide chars as 2", () => {
    // "名前" is 2 CJK glyphs = 4 terminal columns; the column must reserve 4 so
    // the "age" column stays aligned across rows (naive .length would give 2).
    const out = layoutTable(["| 名前 | age |", "|---|---|", "| ada | 36 |"]) as string[];
    expect(out).not.toBeNull();
    expect(out[0]).toBe("名前  age");
    expect(out[1]).toBe("─".repeat(9));
    expect(out[2]).toBe("ada   36");
  });
});

describe("numberDiffLines", () => {
  const d = (kind: DiffLine["kind"], text: string): DiffLine => ({ kind, text });

  it("numbers context/add/del lines from the hunk header", () => {
    const out = numberDiffLines([
      d("hunk", "@@ -10,3 +20,4 @@"),
      d("ctx", " a"),
      d("del", "-b"),
      d("add", "+B"),
      d("add", "+B2"),
      d("ctx", " c"),
    ]);
    expect(out[0]).toEqual({ line: d("hunk", "@@ -10,3 +20,4 @@") });
    expect(out[1]).toMatchObject({ old: 10, new: 20 });
    expect(out[2]).toMatchObject({ old: 11 });
    expect(out[2]?.new).toBeUndefined();
    expect(out[3]).toMatchObject({ new: 21 });
    expect(out[3]?.old).toBeUndefined();
    expect(out[4]).toMatchObject({ new: 22 });
    expect(out[5]).toMatchObject({ old: 12, new: 23 });
  });

  it("resets counters at each hunk header (multi-hunk math)", () => {
    const out = numberDiffLines([
      d("hunk", "@@ -1,2 +1,2 @@"),
      d("ctx", " x"),
      d("hunk", "@@ -100 +200,5 @@"),
      d("add", "+y"),
      d("ctx", " z"),
    ]);
    expect(out[1]).toMatchObject({ old: 1, new: 1 });
    expect(out[3]).toMatchObject({ new: 200 });
    expect(out[4]).toMatchObject({ old: 100, new: 201 });
  });

  it("leaves lines before any hunk header un-numbered", () => {
    const out = numberDiffLines([d("ctx", " pre"), d("add", "+a")]);
    expect(out[0]).toEqual({ line: d("ctx", " pre") });
    expect(out[1]).toEqual({ line: d("add", "+a") });
  });
});

describe("supportsHyperlinks / osc8Link", () => {
  it("recognizes OSC 8-capable TERM_PROGRAM values", () => {
    for (const term of ["iTerm.app", "WezTerm", "kitty", "vscode"]) {
      expect(supportsHyperlinks({ TERM_PROGRAM: term })).toBe(true);
    }
    expect(supportsHyperlinks({ TERM_PROGRAM: "Apple_Terminal" })).toBe(false);
    expect(supportsHyperlinks({})).toBe(false);
  });

  it("honors FORCE_HYPERLINK as an explicit override in both directions", () => {
    expect(supportsHyperlinks({ FORCE_HYPERLINK: "1" })).toBe(true);
    expect(supportsHyperlinks({ FORCE_HYPERLINK: "0", TERM_PROGRAM: "iTerm.app" })).toBe(false);
    expect(supportsHyperlinks({ FORCE_HYPERLINK: "", TERM_PROGRAM: "kitty" })).toBe(true);
  });

  it("wraps text in BEL-terminated OSC 8 escapes when supported", () => {
    const out = osc8Link("docs", "https://example.com", { TERM_PROGRAM: "kitty" });
    expect(out).toBe("\u001B]8;;https://example.com\u0007docs\u001B]8;;\u0007");
  });

  it("returns the bare text when the terminal lacks support", () => {
    expect(osc8Link("docs", "https://example.com", {})).toBe("docs");
    expect(osc8Link("docs", "https://example.com", { TERM_PROGRAM: "Apple_Terminal" })).toBe("docs");
  });
});
