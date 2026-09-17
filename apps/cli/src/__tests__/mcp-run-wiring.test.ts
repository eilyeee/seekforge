/**
 * The run path against a real stdio MCP server, end to end through
 * runTaskCommand: the agent gets the registry-backed dispatcher, so a large
 * tool set is deferred behind tool_search, a tools/list_changed refresh reaches
 * the running loop, and the resource tools are live. Only the model is
 * scripted. Also: who defined a server decides whether the run starts it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, ChatResponse } from "@seekforge/shared";

const { state } = vi.hoisted(() => ({
  state: {
    config: {} as Record<string, unknown>,
    origins: {} as Record<string, "user" | "repository">,
    script: [] as ChatResponse[],
    requests: [] as Array<{ tools: string[]; toolSearch?: string }>,
  },
}));

vi.mock("../config.js", () => ({
  loadConfig: () => state.config,
  resolveConfig: () => ({ config: state.config, mcpOrigins: state.origins }),
}));

vi.mock("../authorized-dirs.js", () => ({
  authorizeDir: vi.fn(),
  isAuthorizedDir: () => true,
}));

vi.mock("@seekforge/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@seekforge/core")>();
  const usage = { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, costUsd: 0 };
  const next = async (req: { tools?: Array<{ name: string; description: string }> }): Promise<ChatResponse> => {
    const search = req.tools?.find((tool) => tool.name === "tool_search");
    state.requests.push({
      tools: (req.tools ?? []).map((tool) => tool.name),
      ...(search ? { toolSearch: search.description } : {}),
    });
    // Anything after the script (memory extraction) gets an empty answer.
    return state.script.shift() ?? { content: "[]", toolCalls: [], usage, finishReason: "stop" };
  };
  return {
    ...real,
    buildAgentCoreDeps: (...args: Parameters<typeof real.buildAgentCoreDeps>) => ({
      ...real.buildAgentCoreDeps(...args),
      provider: { model: "fake", chat: next, chatStream: next },
    }),
  };
});

const { runTaskCommand } = await import("../commands/run.js");
const fixtureUrl = new URL("../../../../packages/core/tests/mcp/dynamic-fixture.ts", import.meta.url).href;
const { writeDynamicServer } = (await import(fixtureUrl)) as {
  writeDynamicServer: () => { serverPath: string; cleanup: () => void };
};

const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0 };
let callId = 0;
const call = (name: string, args: Record<string, unknown> = {}): ChatResponse => ({
  content: "",
  toolCalls: [{ id: `c${++callId}`, name, argumentsJson: JSON.stringify(args) }],
  usage: USAGE,
  finishReason: "tool_calls",
});
const done = (content: string): ChatResponse => ({ content, toolCalls: [], usage: USAGE, finishReason: "stop" });

let serverPath: string;
let cleanupServer: () => void;
let cwd: string;
let home: string;
let events: AgentEvent[];
let err: string[];
const previousHome = process.env["SEEKFORGE_HOME"];

beforeAll(() => {
  ({ serverPath, cleanup: cleanupServer } = writeDynamicServer());
});
afterAll(() => cleanupServer());

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "sf-mcp-run-"));
  home = mkdtempSync(join(tmpdir(), "sf-mcp-home-"));
  process.env["SEEKFORGE_HOME"] = home;
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  events = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    try {
      events.push(JSON.parse(String(line)) as AgentEvent);
    } catch {
      // not an event line
    }
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    err.push(args.join(" "));
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  });
  state.requests = [];
  state.origins = {};
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  if (previousHome === undefined) delete process.env["SEEKFORGE_HOME"];
  else process.env["SEEKFORGE_HOME"] = previousHome;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const server = (extra: Record<string, unknown> = {}) => ({
  command: process.execPath,
  args: [serverPath, "3"],
  ...extra,
});

function results(): Array<{ toolName: string; ok: boolean; text: string }> {
  return events.flatMap((event) =>
    event.type === "tool.completed"
      ? [{ toolName: event.toolName, ok: event.result.ok, text: JSON.stringify(event.result) }]
      : [],
  );
}

describe("a headless run with MCP servers", () => {
  it("defers tools behind tool_search, follows list_changed, and serves resources", async () => {
    state.config = {
      apiKey: "k",
      model: "deepseek-v4-flash",
      mcpServers: { dyn: server({ trusted: true }) },
      // Always defer, so tool_search has to load every MCP tool.
      mcpToolSearchThreshold: 0,
    };
    state.origins = { dyn: "user" };
    state.script = [
      call("tool_search", { query: "select:mcp__dyn__add" }),
      call("mcp__dyn__add", { name: "fresh" }),
      call("tool_search", { query: "select:mcp__dyn__fresh" }),
      call("mcp__dyn__fresh"),
      call("list_mcp_resources"),
      done("all done"),
    ];
    const ok = await runTaskCommand("use the tools", {
      mode: "edit",
      yes: true,
      outputFormat: "stream-json-raw",
    });
    expect(ok).toBe(true);

    const [first, second, third, fourth] = state.requests;
    // Deferred: listed by name inside tool_search, not advertised in full.
    expect(first?.tools).toContain("tool_search");
    expect(first?.tools).not.toContain("mcp__dyn__add");
    expect(first?.tools).toContain("list_mcp_resources");
    expect(first?.toolSearch).toContain("mcp__dyn__add");
    // Loaded by tool_search for the next turn.
    expect(second?.tools).toContain("mcp__dyn__add");
    // The tool `add` created arrived through tools/list_changed, deferred like the rest.
    expect(third?.toolSearch).toContain("mcp__dyn__fresh");
    expect(fourth?.tools).toContain("mcp__dyn__fresh");

    const byTool = results();
    expect(byTool.map((r) => [r.toolName, r.ok])).toEqual([
      ["tool_search", true],
      ["mcp__dyn__add", true],
      ["tool_search", true],
      ["mcp__dyn__fresh", true],
      ["list_mcp_resources", true],
    ]);
    expect(byTool[3]?.text).toContain("ran fresh");
    expect(byTool[4]?.text).toContain("mem://doc");
  });

  it("starts a checkout's server only once approved, and says so", async () => {
    state.config = { apiKey: "k", model: "deepseek-v4-flash", mcpServers: { repo: server() } };
    state.origins = { repo: "repository" };
    state.script = [done("nothing to do")];
    expect(await runTaskCommand("task", { mode: "edit", yes: true, outputFormat: "stream-json-raw" })).toBe(true);
    expect(state.requests[0]?.tools.some((name) => name.startsWith("mcp__repo__"))).toBe(false);
    expect(err.join("\n")).toContain("were not started: repo");
    expect(err.join("\n")).toContain("seekforge mcp approve");
  });

  it("treats an --mcp-config file as the user's, which still needs trusted: true", async () => {
    state.config = { apiKey: "k", model: "deepseek-v4-flash", mcpServers: {} };
    const file = join(cwd, "mcp.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { mine: server({ trusted: true }), loose: server() } }));
    state.script = [done("ok")];
    expect(
      await runTaskCommand("task", {
        mode: "edit",
        yes: true,
        outputFormat: "stream-json-raw",
        mcpConfig: file,
        debug: "mcp",
      }),
    ).toBe(true);
    const tools = state.requests[0]?.tools ?? [];
    expect(tools).toContain("mcp__mine__add");
    expect(tools.some((name) => name.startsWith("mcp__loose__"))).toBe(false);
    const debug = err.join("\n");
    expect(debug).toContain("mine (user, 7 tool(s))");
    expect(debug).toContain("loose (untrusted, not started)");
    // A user entry is never "pending approval".
    expect(debug).not.toContain("were not started");
  });

  it("refuses an out-of-range mcpToolSearchThreshold before anything runs", async () => {
    state.config = {
      apiKey: "k",
      model: "deepseek-v4-flash",
      mcpServers: { dyn: server({ trusted: true }) },
      mcpToolSearchThreshold: 150,
    };
    state.script = [];
    expect(await runTaskCommand("task", { mode: "edit", yes: true, outputFormat: "json" })).toBe(false);
    expect(err.join("\n")).toContain("mcpToolSearchThreshold must be a number from 0 to 100");
    expect(state.requests).toEqual([]);
  });
});
