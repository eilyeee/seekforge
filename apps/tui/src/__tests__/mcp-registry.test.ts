import type { McpClientEntry, McpServerConfig, ToolSpec } from "@seekforge/core";
import { describe, expect, it, vi } from "vitest";
import { createMcpRegistry, type McpLoader } from "../agent/mcp-registry.js";

type FakeServer = { tools: string[]; fail?: string; prompts?: number; resources?: number; invalid?: boolean };

function fakeLoader(servers: Record<string, FakeServer>, disposed: string[] = []): McpLoader {
  return async (map) => {
    const [name] = Object.keys(map) as [string];
    const server = servers[name]!;
    if (server.invalid) {
      process.stderr.write(`warning: MCP server "${name}" has an invalid permission\n`);
      return { specs: [], entries: [], dispose: () => {} };
    }
    const client = {
      listTools: vi.fn(async () => {
        if (server.fail) throw new Error(server.fail);
        return server.tools.map((tool) => ({ name: tool }));
      }),
      listPrompts: vi.fn(async () => Array.from({ length: server.prompts ?? 0 }, (_, i) => ({ name: `p${i}` }))),
      listResources: vi.fn(async () => {
        if (server.resources === undefined) throw new Error("no resources");
        return Array.from({ length: server.resources }, (_, i) => ({ uri: `r${i}` }));
      }),
    };
    const entry = { serverName: name, client, trusted: true } as unknown as McpClientEntry;
    if (server.fail) process.stderr.write(`warning: MCP server "${name}" unavailable: ${server.fail}\n`);
    const specs = server.fail
      ? []
      : server.tools.map((tool) => ({ name: `mcp__${name}__${tool}` }) as unknown as ToolSpec);
    return { specs, entries: [entry], dispose: () => disposed.push(name) };
  };
}

const trusted = (extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
  command: "node",
  trusted: true,
  ...extra,
});

describe("createMcpRegistry", () => {
  it("tracks each server's state, origin and tools", async () => {
    const registry = await createMcpRegistry({
      servers: {
        good: trusted({ args: ["s.js"] }),
        empty: trusted(),
        down: trusted({ url: "https://mcp.example.test/mcp" }),
        raw: { command: "npx", args: ["-y", "thing"] },
        plug__x: trusted(),
      },
      origins: { good: "user", empty: "user", down: "user", raw: "repository" },
      loader: fakeLoader({
        good: { tools: ["a", "b"] },
        empty: { tools: [] },
        down: { tools: [], fail: "connect ECONNREFUSED" },
        plug__x: { tools: ["z"] },
      }),
      quiet: () => true,
    });
    expect(registry.statuses()).toEqual([
      { name: "good", state: "connected", origin: "user", transport: "stdio", target: "node s.js", tools: 2 },
      { name: "empty", state: "connected", origin: "user", transport: "stdio", target: "node", tools: 0 },
      {
        name: "down",
        state: "failed",
        origin: "user",
        transport: "http",
        target: "https://mcp.example.test/mcp",
        tools: 0,
        error: "connect ECONNREFUSED",
      },
      { name: "raw", state: "untrusted", origin: "repository", transport: "stdio", target: "npx -y thing", tools: 0 },
      { name: "plug__x", state: "connected", origin: "plugin", transport: "stdio", target: "node", tools: 1 },
    ]);
    expect(registry.specs().map((s) => s.name)).toEqual(["mcp__good__a", "mcp__good__b", "mcp__plug__x__z"]);
    expect(registry.entries().map((e) => e.serverName)).toEqual(["good", "empty", "plug__x"]);
  });

  it("captures loader warnings once the screen is taken, and restores stderr", async () => {
    const original = process.stderr.write;
    const registry = await createMcpRegistry({
      servers: { bad: trusted({ permission: "nope" as never }), down: trusted() },
      origins: { bad: "user", down: "user" },
      loader: fakeLoader({ bad: { tools: [], invalid: true }, down: { tools: [], fail: "boom" } }),
      quiet: () => true,
    });
    expect(process.stderr.write).toBe(original);
    expect(registry.statuses().map((s) => [s.name, s.state, s.error])).toEqual([
      ["bad", "failed", "has an invalid permission"],
      ["down", "failed", "boom"],
    ]);
  });

  it("reconnects one server and disposes the old connection", async () => {
    const servers: Record<string, FakeServer> = { a: { tools: [], fail: "down" }, b: { tools: ["t"] } };
    const disposed: string[] = [];
    const registry = await createMcpRegistry({
      servers: { a: trusted(), b: trusted() },
      origins: { a: "user", b: "user" },
      loader: fakeLoader(servers, disposed),
      quiet: () => true,
    });
    const seen = vi.fn();
    registry.subscribe(seen);
    servers["a"] = { tools: ["x"] };
    await expect(registry.reconnect("a")).resolves.toMatchObject({ state: "connected", tools: 1 });
    expect(disposed).toEqual(["a"]); // the failed connection was dropped at once
    expect(registry.specs().map((s) => s.name)).toEqual(["mcp__a__x", "mcp__b__t"]);
    await registry.reconnect("b");
    expect(disposed).toEqual(["a", "b"]);
    expect(seen).toHaveBeenCalled();
    await expect(registry.reconnect("missing")).resolves.toBeUndefined();
  });

  it("switches a server off and on through its trust flag", async () => {
    const disposed: string[] = [];
    const registry = await createMcpRegistry({
      servers: { a: trusted() },
      origins: { a: "user" },
      loader: fakeLoader({ a: { tools: ["x"] } }, disposed),
      quiet: () => true,
    });
    await expect(registry.update("a", { command: "node", trusted: false })).resolves.toMatchObject({
      state: "untrusted",
    });
    expect(disposed).toEqual(["a"]);
    expect(registry.specs()).toEqual([]);
    expect(registry.config("a")).toEqual({ command: "node", trusted: false });
    await expect(registry.update("a", trusted())).resolves.toMatchObject({ state: "connected" });
    expect(registry.specs()).toHaveLength(1);
  });

  it("keeps only the newest of two overlapping reconnects", async () => {
    let release: (() => void) | undefined;
    const disposed: string[] = [];
    let calls = 0;
    const base = fakeLoader({ a: { tools: ["x"] } }, disposed);
    const loader: McpLoader = async (...args) => {
      calls += 1;
      if (calls === 2) await new Promise<void>((resolve) => (release = resolve));
      return base(...args);
    };
    const registry = await createMcpRegistry({
      servers: { a: trusted() },
      origins: { a: "user" },
      loader,
      quiet: () => true,
    });
    const slow = registry.reconnect("a");
    const fast = registry.reconnect("a");
    await fast;
    release?.();
    await slow;
    // Initial + slow connection disposed; the fast one is live.
    expect(disposed).toEqual(["a", "a"]);
    expect(registry.statuses()[0]).toMatchObject({ state: "connected" });
    expect(registry.entries()).toHaveLength(1);
  });

  it("counts prompts and resources of connected servers", async () => {
    const registry = await createMcpRegistry({
      servers: { a: trusted(), b: trusted() },
      origins: { a: "user", b: "user" },
      loader: fakeLoader({ a: { tools: ["x"], prompts: 2, resources: 3 }, b: { tools: ["y"], prompts: 1 } }),
      quiet: () => true,
    });
    await registry.refreshCounts();
    expect(registry.statuses().map((s) => [s.name, s.prompts, s.resources])).toEqual([
      ["a", 2, 3],
      ["b", 1, undefined],
    ]);
    registry.dispose();
    expect(registry.specs()).toEqual([]);
  });
});
