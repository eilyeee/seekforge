import { describe, expect, it } from "vitest";
import type { AgentDefinition, McpServerConfig, SessionMeta, ToolSpec } from "@seekforge/core";
import type { BgTask, ChatItem } from "../model.js";
import {
  contextBreakdown,
  formatAgentLines,
  formatBgTaskLines,
  formatMcpLines,
  formatSessionLines,
  gauge,
  gaugeCaption,
} from "../surfaces.js";

function meta(over: Partial<SessionMeta>): SessionMeta {
  return {
    id: "20260612T100000-abc123",
    task: "fix the build",
    mode: "edit",
    status: "completed",
    createdAt: "2026-06-12T10:00:00.000Z",
    updatedAt: "2026-06-12T10:05:00.000Z",
    ...over,
  };
}

function agent(over: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: "explorer",
    name: "Explorer",
    description: "Codebase scout",
    triggers: [],
    mode: "ask",
    scope: "builtin",
    ...over,
  };
}

function mcpSpec(name: string): ToolSpec {
  return { name } as unknown as ToolSpec;
}

describe("formatSessionLines", () => {
  // Two hours after the fixture's updatedAt (2026-06-12T10:05Z).
  const NOW = Date.parse("2026-06-12T12:05:00.000Z");

  it("renders id, status, relative age, cost, and task", () => {
    const lines = formatSessionLines(
      [meta({ usage: { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, costUsd: 0.0123 } })],
      15,
      NOW,
    );
    expect(lines).toEqual(["20260612T100000-abc123  [completed]  2h ago  $0.0123  fix the build"]);
  });

  it("derives the age from updatedAt per session", () => {
    const lines = formatSessionLines(
      [meta({ id: "s-old", updatedAt: "2026-06-09T12:05:00.000Z" }), meta({ id: "s-fresh", updatedAt: "2026-06-12T12:04:40.000Z" })],
      15,
      NOW,
    );
    expect(lines[0]).toContain("3d ago");
    expect(lines[1]).toContain("just now");
  });

  it("shows a dash when the session has no recorded usage", () => {
    const [line] = formatSessionLines([meta({})], 15, NOW);
    expect(line).toContain("  —  ");
  });

  it("collapses multi-line tasks and truncates past 60 chars", () => {
    const task = `line one\n  line two\t${"x".repeat(80)}`;
    const [line] = formatSessionLines([meta({ task })]);
    expect(line).toContain("line one line two");
    expect(line).not.toContain("\n");
    expect(line).toMatch(/…$/);
  });

  it("limits the list (default 15, override honored)", () => {
    const metas = Array.from({ length: 20 }, (_, i) => meta({ id: `s-${i}` }));
    expect(formatSessionLines(metas)).toHaveLength(15);
    expect(formatSessionLines(metas, 3)).toHaveLength(3);
    expect(formatSessionLines(metas, 3)[0]).toContain("s-0");
  });

  it("reports an empty list", () => {
    expect(formatSessionLines([])).toEqual(["no sessions yet"]);
  });
});

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

describe("formatAgentLines", () => {
  it("renders id, mode, description and marks builtins", () => {
    const lines = formatAgentLines([
      agent({}),
      agent({ id: "deployer", mode: "edit", description: "Ships releases", scope: "project" }),
    ]);
    expect(lines[0]).toBe("explorer  (ask)  Codebase scout  [builtin]");
    expect(lines[1]).toBe("deployer  (edit)  Ships releases");
  });

  it("truncates long descriptions to one line", () => {
    const [line] = formatAgentLines([agent({ description: `multi\nline ${"d".repeat(80)}` })]);
    expect(line).not.toContain("\n");
    expect(line).toContain("…");
  });

  it("reports an empty roster", () => {
    expect(formatAgentLines([])).toEqual(["no agents available"]);
  });
});

describe("formatMcpLines", () => {
  const servers: Record<string, McpServerConfig> = {
    github: { command: "npx" },
    fs: { command: "node" },
  };

  it("groups prefixed tool names by server and appends a total", () => {
    const specs = [
      mcpSpec("mcp__github__create_issue"),
      mcpSpec("mcp__github__list_prs"),
      mcpSpec("mcp__fs__read"),
      mcpSpec("read_file"), // non-MCP tool: ignored
    ];
    expect(formatMcpLines(servers, specs)).toEqual([
      "github  2 tools (create_issue, list_prs)",
      "fs  1 tool (read)",
      "total: 3 tools from 2 servers",
    ]);
  });

  it("previews at most 5 tool names with a trailing ellipsis", () => {
    const specs = Array.from({ length: 7 }, (_, i) => mcpSpec(`mcp__fs__t${i}`));
    const lines = formatMcpLines({ fs: { command: "node" } }, specs);
    expect(lines[0]).toBe("fs  7 tools (t0, t1, t2, t3, t4, …)");
    expect(lines[1]).toBe("total: 7 tools from 1 server");
  });

  it("renders a configured server that contributed zero tools", () => {
    const lines = formatMcpLines({ down: { command: "npx" } }, []);
    expect(lines[0]).toBe("down  0 tools");
  });

  it("handles double-underscored tool names (greedy tail after server)", () => {
    const lines = formatMcpLines({ srv: { command: "x" } }, [mcpSpec("mcp__srv__do__thing")]);
    expect(lines[0]).toBe("srv  1 tool (do__thing)");
  });

  it("reports no configuration for undefined or empty servers", () => {
    expect(formatMcpLines(undefined, [])).toEqual(["no MCP servers configured"]);
    expect(formatMcpLines({}, [])).toEqual(["no MCP servers configured"]);
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
    expect(rows.map((r) => r.label)).toEqual([
      "tool results",
      "assistant text",
      "user messages",
      "shell output",
    ]);
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
