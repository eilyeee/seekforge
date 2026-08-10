import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginScaffold,
  installPlugin,
  listPlugins,
  loadPluginContributions,
  pluginSupplyChainReport,
  removePlugin,
  rollbackPlugin,
  setPluginEnabled,
} from "../../src/plugins/index.js";
import { loadSkills } from "../../src/skills/index.js";
import { loadAgentDefinitions } from "../../src/subagents/index.js";
import { graphExecutorsWithPlugins, graphHandlersWithPlugins } from "../../src/agent/graph-handlers.js";

const previousHome = process.env.SEEKFORGE_HOME;
const roots: string[] = [];

function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  if (previousHome === undefined) delete process.env.SEEKFORGE_HOME;
  else process.env.SEEKFORGE_HOME = previousHome;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("first-class plugins", () => {
  it("discovers project plugins for review, installs disabled, and enables an approved digest", () => {
    const home = temp("seekforge-plugin-home-");
    const workspace = temp("seekforge-plugin-workspace-");
    process.env.SEEKFORGE_HOME = home;
    const scaffold = createPluginScaffold(workspace, "demo-plugin");
    fs.mkdirSync(path.join(scaffold.path, "skills", "plugin-skill"));
    fs.writeFileSync(
      path.join(scaffold.path, "skills", "plugin-skill", "skill.json"),
      JSON.stringify({
        id: "plugin-skill",
        name: "Plugin skill",
        description: "from plugin",
        tags: [],
        triggers: [],
        priority: 50,
        enabled: true,
        risk: "medium",
      }),
    );
    fs.writeFileSync(path.join(scaffold.path, "skills", "plugin-skill", "SKILL.md"), "# Plugin skill\n");
    fs.mkdirSync(path.join(scaffold.path, "agents", "plugin-agent"));
    fs.writeFileSync(
      path.join(scaffold.path, "agents", "plugin-agent", "AGENT.md"),
      "---\nname: Plugin agent\ndescription: from plugin\n---\n# Procedure\n",
    );
    fs.writeFileSync(
      path.join(scaffold.path, "plugin.json"),
      `${JSON.stringify({
        ...scaffold.manifest,
        contributes: {
          ...scaffold.manifest.contributes,
          mcpServers: { docs: { url: "https://example.test/mcp", permission: "readonly" } },
          hooks: { sessionStart: [{ command: "node check.mjs" }] },
          graphHandlers: { summarize: "collect" },
          graphExecutors: { deploy: "remote-worker" },
        },
      })}\n`,
    );

    expect(listPlugins(workspace)[0]).toMatchObject({ id: "demo-plugin", scope: "project", status: "review_required" });
    installPlugin(scaffold.path);
    expect(listPlugins(workspace).find((plugin) => plugin.scope === "global")).toMatchObject({ status: "disabled" });
    expect(loadPluginContributions(workspace).mcpServers).toEqual({});

    setPluginEnabled("demo-plugin", true);
    expect(loadPluginContributions(workspace).mcpServers["demo-plugin__docs"]).toMatchObject({
      url: "https://example.test/mcp",
      trusted: false,
      permission: "readonly",
    });
    expect(loadPluginContributions(workspace).hooks.sessionStart).toEqual([{ command: "node check.mjs" }]);
    const contributions = loadPluginContributions(workspace);
    expect(contributions.graphHandlers).toEqual({ "demo-plugin__summarize": "collect" });
    expect(graphHandlersWithPlugins(contributions)["demo-plugin__summarize"]).toBeTypeOf("function");
    const trustedRemote = { trusted: true as const, locality: "remote" as const, execute: vi.fn() };
    expect(graphExecutorsWithPlugins(contributions, { "remote-worker": trustedRemote })).toEqual({
      "demo-plugin__deploy": trustedRemote,
    });
    expect(
      graphExecutorsWithPlugins(contributions, {
        "remote-worker": { ...trustedRemote, trusted: false },
      }),
    ).toEqual({});
    expect(loadSkills(workspace).find((skill) => skill.id === "plugin-skill")).toMatchObject({
      description: "from plugin",
      scope: "global",
    });
    expect(loadAgentDefinitions(workspace).find((agent) => agent.id === "plugin-agent")).toMatchObject({
      name: "Plugin agent",
      scope: "global",
    });

    fs.appendFileSync(path.join(home, ".seekforge", "plugins", "demo-plugin", "plugin.json"), " ");
    expect(listPlugins(workspace).find((plugin) => plugin.scope === "global")?.status).toBe("changed");
    expect(loadPluginContributions(workspace).mcpServers).toEqual({});
  });

  it("grants MCP connection trust only where the reviewed manifest declares it", () => {
    const home = temp("seekforge-plugin-home-");
    const workspace = temp("seekforge-plugin-workspace-");
    process.env.SEEKFORGE_HOME = home;
    const scaffold = createPluginScaffold(workspace, "trust-plugin");
    fs.writeFileSync(
      path.join(scaffold.path, "plugin.json"),
      `${JSON.stringify({
        ...scaffold.manifest,
        version: "1.0.0+build.7",
        contributes: {
          ...scaffold.manifest.contributes,
          mcpServers: {
            silent: { url: "https://silent.test/mcp" },
            declined: { command: "node", args: ["server.mjs"], trusted: false },
            declared: { url: "https://declared.test/mcp", trusted: true, permission: "readonly" },
          },
        },
      })}\n`,
    );
    installPlugin(scaffold.path);
    setPluginEnabled("trust-plugin", true);

    const servers = loadPluginContributions(workspace).mcpServers;
    // An omitted flag keeps the McpServerConfig default; an explicit false is a
    // decision the loader must never widen into an automatic connection.
    expect(servers["trust-plugin__silent"]).toMatchObject({ trusted: false });
    expect(servers["trust-plugin__declined"]).toMatchObject({ trusted: false });
    expect(servers["trust-plugin__declared"]).toMatchObject({ trusted: true, permission: "readonly" });
    expect(pluginSupplyChainReport(workspace).entries.find((entry) => entry.scope === "global")).toMatchObject({
      version: "1.0.0+build.7",
      capabilities: ["skills", "agents", "mcp"],
    });
  });

  it("rejects symbolic links and removes approval state on uninstall", () => {
    const home = temp("seekforge-plugin-home-");
    const workspace = temp("seekforge-plugin-workspace-");
    process.env.SEEKFORGE_HOME = home;
    const scaffold = createPluginScaffold(workspace, "linked-plugin");
    fs.symlinkSync(path.join(scaffold.path, "plugin.json"), path.join(scaffold.path, "linked.json"));
    expect(() => installPlugin(scaffold.path)).toThrow(/symbolic link/);
    fs.unlinkSync(path.join(scaffold.path, "linked.json"));
    installPlugin(scaffold.path);
    setPluginEnabled("linked-plugin", true);
    removePlugin("linked-plugin");
    expect(listPlugins(workspace).filter((plugin) => plugin.scope === "global")).toEqual([]);
  });

  it("refuses to scaffold or install through a symlinked plugin store", () => {
    const home = temp("seekforge-plugin-home-");
    const workspace = temp("seekforge-plugin-workspace-");
    const outside = temp("seekforge-plugin-outside-");
    process.env.SEEKFORGE_HOME = home;
    fs.mkdirSync(path.join(workspace, ".seekforge"));
    fs.symlinkSync(outside, path.join(workspace, ".seekforge", "plugins"));
    expect(() => createPluginScaffold(workspace, "escaped-plugin")).toThrow(/physical directory/);
    expect(fs.existsSync(path.join(outside, "escaped-plugin"))).toBe(false);

    const sourceWorkspace = temp("seekforge-plugin-source-");
    const source = createPluginScaffold(sourceWorkspace, "safe-plugin");
    fs.mkdirSync(path.join(home, ".seekforge"));
    fs.symlinkSync(outside, path.join(home, ".seekforge", "plugins"));
    expect(() => installPlugin(source.path)).toThrow(/physical directory/);
  });

  it("reports locked capabilities and atomically rolls back an update", () => {
    const home = temp("seekforge-plugin-home-");
    const workspace = temp("seekforge-plugin-workspace-");
    process.env.SEEKFORGE_HOME = home;
    const scaffold = createPluginScaffold(workspace, "versioned-plugin");
    installPlugin(scaffold.path);
    setPluginEnabled("versioned-plugin", true);
    expect(pluginSupplyChainReport(workspace).entries.find((entry) => entry.scope === "global")).toMatchObject({
      integrity: "verified",
      capabilities: ["skills", "agents"],
      rollbackAvailable: false,
    });

    fs.writeFileSync(
      path.join(scaffold.path, "plugin.json"),
      `${JSON.stringify({ ...scaffold.manifest, version: "0.2.0" })}\n`,
    );
    installPlugin(scaffold.path, { force: true });
    expect(pluginSupplyChainReport(workspace).entries.find((entry) => entry.scope === "global")).toMatchObject({
      version: "0.2.0",
      rollbackAvailable: true,
    });
    expect(rollbackPlugin("versioned-plugin").manifest.version).toBe("0.1.0");
    expect(listPlugins(workspace).find((plugin) => plugin.scope === "global")).toMatchObject({
      status: "disabled",
      manifest: { version: "0.1.0" },
    });
  });
});
