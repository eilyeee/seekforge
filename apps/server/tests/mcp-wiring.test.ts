// Cross-lane wiring for MCP on the server: which servers a run connects, the
// tool-search deferral, `.mcp.json` as a repository layer, and the trust an
// explicit management action uses.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mcpToolPublicName, TOOL_SEARCH_TOOL } from "@seekforge/core";
import { prepareAgentDeps } from "../src/agent.js";
import { resolveServerConfig } from "../src/config.js";
import { startServer, type RunningServer } from "../src/index.js";
import { makeWorkspace, unusedAgentFactory, writeFileIn } from "./helpers.js";
import { writeFixtureServer } from "./mcp-fixture.js";

const TOKEN = "test-token-mcp-wiring";
const savedHome = process.env["SEEKFORGE_HOME"];
const savedArg = process.env["SF_WIRING_FIXTURE"];
let fixture: ReturnType<typeof writeFixtureServer>;

beforeAll(() => {
  fixture = writeFixtureServer();
});

afterAll(() => {
  fixture.cleanup();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env["SEEKFORGE_HOME"];
  else process.env["SEEKFORGE_HOME"] = savedHome;
  if (savedArg === undefined) delete process.env["SF_WIRING_FIXTURE"];
  else process.env["SF_WIRING_FIXTURE"] = savedArg;
});

function setup(global: Record<string, unknown>, files: Record<string, unknown> = {}): string {
  const home = makeWorkspace();
  const workspace = makeWorkspace();
  writeFileIn(home, ".seekforge/config.json", JSON.stringify({ apiKey: "sk-test", ...global }));
  for (const [rel, content] of Object.entries(files)) writeFileIn(workspace, rel, JSON.stringify(content));
  process.env["SEEKFORGE_HOME"] = home;
  return workspace;
}

describe(".mcp.json joins the server merge as a repository layer", () => {
  it("adds its servers below .seekforge/config.json and never above the user's", () => {
    const workspace = setup(
      { mcpServers: { mine: { command: "user-owned", trusted: true } } },
      {
        ".mcp.json": {
          mcpServers: {
            mine: { command: "repo-repoint" },
            docs: { command: "from-mcp-json", trusted: true, oauth: { clientId: "x" } },
            shared: { command: "from-mcp-json" },
          },
        },
        ".seekforge/config.json": { mcpServers: { shared: { command: "from-seekforge-config" } } },
      },
    );
    const { config, mcpOrigins } = resolveServerConfig(workspace);
    expect(config.mcpServers?.["mine"]?.command).toBe("user-owned");
    expect(mcpOrigins["mine"]).toBe("user");
    expect(config.mcpServers?.["docs"]).toEqual({ command: "from-mcp-json" });
    expect(mcpOrigins["docs"]).toBe("repository");
    expect(config.mcpServers?.["shared"]?.command).toBe("from-seekforge-config");
  });
});

describe("the run's MCP assembly", () => {
  it("connects only allowed servers and hands the registry to an MCP-aware dispatcher", async () => {
    const workspace = setup(
      {
        mcpToolSearchThreshold: 0,
        mcpServers: { tools: { command: process.execPath, args: [fixture.serverPath], trusted: true } },
      },
      { ".mcp.json": { mcpServers: { repo: { command: process.execPath, args: [fixture.serverPath] } } } },
    );
    const { deps, registry, disposeMcp } = await prepareAgentDeps({
      workspace,
      confirm: async () => false,
      extractMemory: false,
    });
    try {
      expect(registry.servers().map(({ name, state }) => ({ name, state }))).toEqual([
        { name: "tools", state: "connected" },
        { name: "repo", state: "pending" },
      ]);
      expect(registry.toolSearchThreshold).toBe(0);
      const echo = mcpToolPublicName("tools", "echo");
      const dispatcher = deps.dispatcher as { listForBudget?: (budget: number) => Array<{ name: string }> };
      expect(dispatcher.listForBudget).toBeTypeOf("function");
      // Threshold 0 always defers: tool_search is advertised, the MCP tool is not.
      const advertised = dispatcher.listForBudget!(100_000).map((tool) => tool.name);
      expect(advertised).toContain(TOOL_SEARCH_TOOL);
      expect(advertised).not.toContain(echo);
      // Every connected tool is still callable (listed in full), exactly once.
      const all = deps.dispatcher.list().map((tool) => tool.name);
      expect(all.filter((name) => name === echo)).toHaveLength(1);
      expect(all.some((name) => name.startsWith("mcp__repo__"))).toBe(false);
    } finally {
      deps.runtime?.dispose();
      disposeMcp();
    }
  });

  it("reports an out-of-range threshold instead of silently ignoring it", async () => {
    const workspace = setup({ mcpToolSearchThreshold: 250 });
    await expect(prepareAgentDeps({ workspace, confirm: async () => false, extractMemory: false })).rejects.toThrow(
      /mcpToolSearchThreshold/,
    );
  });
});

describe("MCP management actions over REST", () => {
  let server: RunningServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function boot(workspace: string): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
    server = await startServer({ workspace, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
    const base = `http://127.0.0.1:${server.port}`;
    return (path, init = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      });
  }

  it("tests a user-owned server with the user's trust, so its ${VAR} references expand", async () => {
    process.env["SF_WIRING_FIXTURE"] = fixture.serverPath;
    const workspace = setup({
      // Not trusted for automatic connection — but the user wrote it, and
      // "Test" is the user's explicit action.
      mcpServers: { mine: { command: process.execPath, args: ["${SF_WIRING_FIXTURE}"] } },
    });
    const call = await boot(workspace);
    const tested = await call("/api/mcp/mine/test", { method: "POST" });
    expect(tested.status).toBe(200);
    expect(await tested.json()).toMatchObject({ ok: true, toolCount: 2 });
    const tools = await call("/api/mcp/mine/tools", { method: "POST" });
    expect(tools.status).toBe(200);
  });

  it("lists resources and prompts only from servers a run would connect", async () => {
    const workspace = setup(
      {
        mcpServers: {
          trusted: { command: process.execPath, args: [fixture.serverPath], trusted: true },
          untrusted: { command: process.execPath, args: [fixture.serverPath] },
        },
      },
      { ".seekforge/config.json": { mcpServers: { repo: { command: process.execPath, args: [fixture.serverPath] } } } },
    );
    const call = await boot(workspace);
    const servers = async (path: string, key: "resources" | "prompts") => [
      ...new Set(
        ((await (await call(path)).json()) as Record<string, Array<{ server: string }>>)[key]!.map((r) => r.server),
      ),
    ];
    expect(await servers("/api/mcp/resources", "resources")).toEqual(["trusted"]);
    expect(await servers("/api/mcp/prompts", "prompts")).toEqual(["trusted"]);
    expect((await call("/api/mcp/prompts/repo/greet", { method: "POST", body: "{}" })).status).toBe(403);

    const { servers: pending } = (await (await call("/api/mcp/project-servers")).json()) as {
      servers: Array<{ name: string; digest: string }>;
    };
    const approved = await call("/api/mcp/project-servers/repo/approve", {
      method: "POST",
      body: JSON.stringify({ digest: pending[0]!.digest }),
    });
    expect(approved.status).toBe(200);
    expect(await servers("/api/mcp/resources", "resources")).toEqual(["trusted", "repo"]);
    const prompt = await call("/api/mcp/prompts/repo/greet", {
      method: "POST",
      body: JSON.stringify({ arguments: { who: "repo" } }),
    });
    expect(prompt.status).toBe(200);
    expect(await prompt.json()).toEqual({ text: expect.stringContaining("Hello repo") });
  });
});
