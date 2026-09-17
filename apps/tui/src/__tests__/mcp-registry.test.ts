import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMcpAwareDispatcher,
  projectMcpServerStatus,
  type McpClientEntry,
  type McpRegistry as CoreMcpRegistry,
  type McpRegistryEvent,
  type McpServerConfig,
  type McpServerStatus as CoreStatus,
} from "@seekforge/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpRegistry, type McpLoader, type McpRegistry } from "../agent/mcp-registry.js";

/** A stdio MCP server: one tool, `prompts` prompts, and a resource list that fails unless `resources` is given. */
const SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const prompts = Number(process.argv[2] || 0);
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: {}, prompts: {} }, serverInfo: { name: "fake", version: "0" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "ping", description: "Answers pong.", inputSchema: { type: "object", properties: {} } },
    ] } });
  } else if (msg.method === "prompts/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { prompts: Array.from({ length: prompts }, (_, i) => ({ name: "p" + i })) } });
  } else {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no " + msg.method } });
  }
});
`;

let dir: string;
let serverPath: string;
let home: string;
let workspace: string;
const previousHome = process.env["SEEKFORGE_HOME"];
const registries: McpRegistry[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tui-mcp-server-"));
  serverPath = join(dir, "server.cjs");
  writeFileSync(serverPath, SERVER);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tui-mcp-home-"));
  workspace = mkdtempSync(join(tmpdir(), "tui-mcp-ws-"));
  process.env["SEEKFORGE_HOME"] = home;
});
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
  if (previousHome === undefined) delete process.env["SEEKFORGE_HOME"];
  else process.env["SEEKFORGE_HOME"] = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

const fake = (prompts = 0, extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
  command: process.execPath,
  args: [serverPath, String(prompts)],
  ...extra,
});

async function open(...args: Parameters<typeof createMcpRegistry>): Promise<McpRegistry> {
  const registry = await createMcpRegistry(...args);
  registries.push(registry);
  return registry;
}

const stateOf = (registry: McpRegistry, name: string) => registry.statuses().find((s) => s.name === name)?.state;

describe("createMcpRegistry over core's registry", () => {
  it("connects a trusted user server and leaves an untrusted one and a pending repository one alone", async () => {
    const registry = await open({
      servers: { mine: fake(0, { trusted: true }), off: fake(), repo: fake() },
      origins: { mine: "user", off: "user", repo: "repository" },
      workspace,
      roots: [workspace],
    });
    const statuses = registry.statuses();
    expect(statuses.map((s) => [s.name, s.state, s.origin, s.transport, s.tools])).toEqual([
      ["mine", "connected", "user", "stdio", 1],
      ["off", "disabled", "user", "stdio", 0],
      ["repo", "pending", "repository", "stdio", 0],
    ]);
    expect(statuses[0]?.target).toBe(`${process.execPath} ${serverPath} 0`);
    // Only a repository server carries the definition the user approves.
    expect(statuses[0]?.definition).toBeUndefined();
    expect(JSON.parse(statuses[2]?.definition ?? "{}")).toEqual({ args: [serverPath, "0"], command: process.execPath });
    expect(registry.entries().map((entry) => entry.serverName)).toEqual(["mine"]);
    // The run's dispatcher is built over the same core registry.
    const dispatcher = createMcpAwareDispatcher(registry.core);
    expect(dispatcher.list().map((tool) => tool.name)).toContain("mcp__mine__ping");
  }, 20_000);

  it("switches a user server on and off through the trust flag, without touching the caller's config", async () => {
    const config = fake();
    const registry = await open({ servers: { mine: config }, origins: { mine: "user" }, workspace });
    const changes = vi.fn();
    registry.subscribe(changes);
    await expect(registry.setTrusted("mine", true)).resolves.toMatchObject({ state: "connected", tools: 1 });
    expect(registry.entries()).toHaveLength(1);
    expect(changes).toHaveBeenCalled();
    await expect(registry.setTrusted("mine", false)).resolves.toMatchObject({ state: "disabled", tools: 0 });
    expect(registry.entries()).toEqual([]);
    expect(config.trusted).toBeUndefined();
    expect(registry.config("mine")?.trusted).toBe(false);
  }, 20_000);

  it("records a project decision for this workspace and applies it at once", async () => {
    const config = fake();
    const registry = await open({ servers: { repo: config }, origins: { repo: "repository" }, workspace });
    expect(stateOf(registry, "repo")).toBe("pending");
    await expect(registry.decide("repo", "approve")).resolves.toMatchObject({ state: "connected", tools: 1 });
    expect(projectMcpServerStatus(workspace, "repo", config)).toBe("approved");
    await expect(registry.decide("repo", "reject")).resolves.toMatchObject({ state: "rejected", tools: 0 });
    expect(projectMcpServerStatus(workspace, "repo", config)).toBe("rejected");
    expect(registry.entries()).toEqual([]);
  }, 20_000);

  it("refuses the grant that does not fit the server's origin, and unknown names", async () => {
    const registry = await open({
      servers: { mine: fake(), repo: fake(), plug__x: fake() },
      origins: { mine: "user", repo: "repository" },
      workspace,
    });
    // A repository's trust flag means nothing; a user's server is never "approved".
    await expect(registry.setTrusted("repo", true)).resolves.toBeUndefined();
    await expect(registry.setTrusted("plug__x", true)).resolves.toBeUndefined();
    await expect(registry.decide("mine", "approve")).resolves.toBeUndefined();
    await expect(registry.decide("plug__x", "approve")).resolves.toBeUndefined();
    await expect(registry.reconnect("missing")).resolves.toBeUndefined();
    await expect(registry.decide("__proto__", "approve")).resolves.toBeUndefined();
    expect(registry.statuses().map((s) => [s.name, s.state, s.origin])).toEqual([
      ["mine", "disabled", "user"],
      ["repo", "pending", "repository"],
      ["plug__x", "disabled", "plugin"],
    ]);
    expect(projectMcpServerStatus(workspace, "repo", fake())).toBe("pending");
  });

  it("counts prompts, and forgets the counts of a connection that was replaced", async () => {
    const registry = await open({
      servers: { mine: fake(2, { trusted: true }) },
      origins: { mine: "user" },
      workspace,
    });
    await registry.refreshCounts();
    expect(registry.statuses()[0]).toMatchObject({ state: "connected", prompts: 2 });
    // resources/list fails on this server: no count rather than a wrong one.
    expect(registry.statuses()[0]?.resources).toBeUndefined();
    await registry.reconnect("mine");
    expect(registry.statuses()[0]?.prompts).toBeUndefined();
  }, 20_000);

  it("keeps core's warnings off the screen once it is taken, and restores stderr", async () => {
    const original = process.stderr.write;
    const writes: string[] = [];
    const spy = vi.fn((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    process.stderr.write = spy as unknown as typeof process.stderr.write;
    try {
      const registry = await open({
        servers: { broken: { command: process.execPath, args: ["-e", "process.exit(3)"], trusted: true } },
        origins: { broken: "user" },
        workspace,
        quiet: () => true,
      });
      await registry.reconnect("broken");
      expect(registry.statuses()[0]).toMatchObject({ state: "failed" });
      expect(registry.statuses()[0]?.error).toBeTruthy();
      expect(writes).toEqual([]);
      expect(process.stderr.write).toBe(spy);
    } finally {
      process.stderr.write = original;
    }
  }, 20_000);

  it("rejects an out-of-range mcpToolSearchThreshold", async () => {
    await expect(createMcpRegistry({ servers: {}, origins: {}, workspace, toolSearchThreshold: 150 })).rejects.toThrow(
      /mcpToolSearchThreshold/,
    );
  });
});

describe("createMcpRegistry with a stand-in core registry", () => {
  function fakeCore(servers: CoreStatus[], entries: McpClientEntry[] = []) {
    const listeners = new Set<(event: McpRegistryEvent) => void>();
    const core = {
      revision: () => 0,
      entries: () => entries,
      toolSpecs: () => [],
      servers: () => servers,
      refresh: vi.fn(async () => {}),
      reconnect: vi.fn(async (name: string) => servers.find((s) => s.name === name) as CoreStatus),
      subscribe: (listener: (event: McpRegistryEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      toolSearchThreshold: 10,
      dispose: vi.fn(),
    } satisfies CoreMcpRegistry;
    const emit = (event: McpRegistryEvent): void => {
      for (const listener of listeners) listener(event);
    };
    return { core, emit };
  }

  it("hands core the workspace, the origins and the threshold, and copies the definitions", async () => {
    const { core } = fakeCore([]);
    const loader = vi.fn<McpLoader>(async () => ({ registry: core, dispose: core.dispose }));
    const servers = { remote: { url: "https://mcp.example.test/mcp", trusted: true } as McpServerConfig };
    const registry = await open({
      servers,
      origins: { remote: "user" },
      workspace: "/abs/ws",
      roots: ["/abs/ws"],
      toolSearchThreshold: 25,
      loader,
    });
    const [passed, roots, handlers, options] = loader.mock.calls[0]!;
    expect(passed).toEqual(servers);
    expect(passed["remote"]).not.toBe(servers.remote);
    expect(roots).toEqual(["/abs/ws"]);
    expect(handlers).toBeUndefined();
    expect(options).toEqual({ workspace: "/abs/ws", origins: { remote: "user" }, toolSearchThreshold: 25 });
    registry.dispose();
    registry.dispose();
    expect(core.dispose).toHaveBeenCalledOnce();
  });

  it("describes each server with its origin and raw target, and relays core's events", async () => {
    const { core, emit } = fakeCore([
      { name: "remote", state: "failed", transport: "http", toolCount: 0, error: "connect ECONNREFUSED" },
      { name: "legacy", state: "connected", transport: "sse", toolCount: 3 },
      { name: "odd", state: "invalid", toolCount: 0, error: "unsupported MCP transport type" },
    ]);
    const registry = await open({
      servers: {
        remote: { url: "https://mcp.example.test/mcp", trusted: true },
        legacy: { type: "sse", url: "https://legacy.example.test/sse", trusted: true },
        odd: { type: "websocket" as never, command: "node", args: ["s.js"] },
      },
      origins: { remote: "user", legacy: "user" },
      workspace: "/abs/ws",
      loader: async () => ({ registry: core, dispose: () => {} }),
    });
    expect(registry.statuses()).toEqual([
      {
        name: "remote",
        state: "failed",
        origin: "user",
        transport: "http",
        target: "https://mcp.example.test/mcp",
        tools: 0,
        error: "connect ECONNREFUSED",
      },
      {
        name: "legacy",
        state: "connected",
        origin: "user",
        transport: "sse",
        target: "https://legacy.example.test/sse",
        tools: 3,
      },
      {
        name: "odd",
        state: "invalid",
        origin: "plugin",
        target: "node s.js",
        tools: 0,
        error: "unsupported MCP transport type",
      },
    ]);
    const seen = vi.fn();
    const unsubscribe = registry.subscribe(seen);
    emit({ server: "legacy", kind: "tools" });
    expect(seen).toHaveBeenCalledOnce();
    unsubscribe();
    emit({ server: "legacy", kind: "tools" });
    expect(seen).toHaveBeenCalledOnce();
  });
});
