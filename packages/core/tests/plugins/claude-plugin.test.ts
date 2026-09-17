import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installPlugin,
  listPlugins,
  loadPluginContributions,
  mergePluginLspServers,
  pluginSupplyChainReport,
  readPluginManifestDetailed,
  setPluginEnabled,
} from "../../src/plugins/index.js";
import { loadSkills } from "../../src/skills/index.js";
import { listOutputStyles, loadUserCommands, resolveOutputStyle } from "../../src/agent/index.js";

let previousHome: string | undefined;
const roots: string[] = [];
let home: string;
let workspace: string;

function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  previousHome = process.env.SEEKFORGE_HOME;
  home = temp("seekforge-claude-plugin-home-");
  workspace = temp("seekforge-claude-plugin-ws-");
  process.env.SEEKFORGE_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.SEEKFORGE_HOME;
  else process.env.SEEKFORGE_HOME = previousHome;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A Claude Code plugin with every component SeekForge maps, plus some it does not. */
function claudePlugin(name = "cc-tools"): string {
  const dir = path.join(temp("seekforge-claude-plugin-src-"), name);
  write(
    path.join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, description: "Claude Code tools", author: { name: "someone" }, keywords: ["x"] }),
  );
  write(
    path.join(dir, "skills", "cc-skill", "SKILL.md"),
    "---\ndescription: from a Claude plugin\n---\nRun ${CLAUDE_PLUGIN_ROOT}/bin/tool\n",
  );
  write(path.join(dir, "commands", "deploy.md"), "---\ndescription: Deploy it\n---\nDeploy $ARGUMENTS\n");
  write(path.join(dir, "commands", "ops", "status.md"), "Show status\n");
  write(path.join(dir, "agents", "helper.md"), "---\nname: helper\n---\nhelp\n");
  write(path.join(dir, "output-styles", "terse.md"), "---\nname: terse\n---\nAnswer tersely.\n");
  write(
    path.join(dir, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Write|Edit", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/check.sh" }] },
          { matcher: "Notebook.*", hooks: [{ type: "command", command: "never.sh" }] },
        ],
        SessionStart: [
          { hooks: [{ type: "command", command: "echo start" }] },
          { matcher: "resume", hooks: [{ type: "command", command: "echo resumed" }] },
        ],
        PostToolUseFailure: [{ hooks: [{ type: "command", command: "echo failed" }] }],
        Stop: [{ hooks: [{ type: "prompt", prompt: "are you done?" }] }],
      },
    }),
  );
  write(
    path.join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        Local_Server: {
          command: "${CLAUDE_PLUGIN_ROOT}/bin/server",
          args: ["--root", "${CLAUDE_PLUGIN_ROOT}"],
          env: { A: "1" },
        },
        remote: { type: "http", url: "https://mcp.example.test" },
        legacy: { type: "sse", url: "https://sse.example.test" },
      },
    }),
  );
  write(
    path.join(dir, ".lsp.json"),
    JSON.stringify({
      foo: { command: "foo-ls", args: ["--stdio"], extensionToLanguage: { ".foo": "foolang" } },
      broken: { command: "x" },
    }),
  );
  return dir;
}

describe("Claude Code plugins", () => {
  it("translates the manifest and every mappable component, reporting the rest", () => {
    const source = claudePlugin();
    const root = fs.realpathSync(source);
    const { manifest, format, warnings } = readPluginManifestDetailed(source);
    expect(format).toBe("claude");
    expect(manifest).toMatchObject({
      apiVersion: 1,
      id: "cc-tools",
      name: "cc-tools",
      version: "0.0.0",
      description: "Claude Code tools",
      contributes: {
        skillRoots: ["skills"],
        agentRoots: ["agents"],
        commandRoots: ["commands"],
        outputStyleRoots: ["output-styles"],
      },
    });
    const prefix = `export CLAUDE_PLUGIN_ROOT='${root}'; `;
    expect(manifest.contributes?.hooks).toEqual({
      preToolUse: [
        { match: "write_file", command: `${prefix}\${CLAUDE_PLUGIN_ROOT}/hooks/check.sh` },
        { match: "apply_patch", command: `${prefix}\${CLAUDE_PLUGIN_ROOT}/hooks/check.sh` },
      ],
      sessionStart: [{ command: `${prefix}echo start` }],
    });
    expect(manifest.contributes?.mcpServers).toEqual({
      "local-server": {
        command: `${root}/bin/server`,
        args: ["--root", root],
        env: { A: "1" },
        trusted: true,
      },
      remote: { url: "https://mcp.example.test", trusted: true },
    });
    expect(manifest.contributes?.lspServers).toEqual({
      foo: { command: "foo-ls", args: ["--stdio"], extensionToLanguage: { ".foo": "foolang" } },
    });
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('PreToolUse hook matcher "Notebook.*" cannot be translated'),
        expect.stringContaining('SessionStart hook matcher "resume" cannot be translated'),
        "hook event PostToolUseFailure is not supported and was skipped",
        'Stop hook of type "prompt" is not supported and was skipped',
        expect.stringContaining("hook commands receive SeekForge's hook payload"),
        expect.stringContaining('MCP server "legacy" uses transport sse'),
        expect.stringContaining('language server "broken" is invalid'),
        expect.stringContaining("agents in agents/*.md use Claude Code's flat layout"),
      ]),
    );
  });

  it("honors manifest component paths: skills add, the others replace, escapes are refused", () => {
    const dir = path.join(temp("seekforge-claude-plugin-src-"), "paths");
    write(
      path.join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "paths",
        version: "2.1.0",
        skills: "./extra-skills",
        commands: ["./cmds", "../outside", "./missing", "./cmds/one.md"],
        hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "echo after" }] }] },
        mcpServers: "./config/mcp.json",
      }),
    );
    write(path.join(dir, "skills", "a", "SKILL.md"), "a\n");
    write(path.join(dir, "extra-skills", "b", "SKILL.md"), "b\n");
    write(path.join(dir, "commands", "ignored.md"), "ignored\n");
    write(path.join(dir, "cmds", "one.md"), "one\n");
    write(path.join(dir, "config", "mcp.json"), JSON.stringify({ srv: { command: "node" } }));
    const { manifest, warnings } = readPluginManifestDetailed(dir);
    expect(manifest.version).toBe("2.1.0");
    expect(manifest.contributes).toMatchObject({
      skillRoots: ["skills", "extra-skills"],
      commandRoots: ["cmds"],
      hooks: { postToolUse: [{ command: expect.stringContaining("echo after") }] },
      mcpServers: { srv: { command: "node", trusted: true } },
    });
    expect(warnings).toEqual(
      expect.arrayContaining([
        'commands path "../outside" leaves the plugin directory',
        'commands path "./missing" was not found',
        'commands path "./cmds/one.md" is not a directory; only directories are supported',
      ]),
    );
  });

  it("refuses an unusable manifest and a symlinked .claude-plugin directory", () => {
    const bad = path.join(temp("seekforge-claude-plugin-src-"), "bad");
    write(path.join(bad, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "Not Kebab" }));
    expect(() => readPluginManifestDetailed(bad)).toThrow(/kebab-case/);

    const linked = path.join(temp("seekforge-claude-plugin-src-"), "linked");
    const elsewhere = temp("seekforge-claude-plugin-elsewhere-");
    write(path.join(elsewhere, "plugin.json"), JSON.stringify({ name: "linked" }));
    fs.mkdirSync(linked);
    fs.symlinkSync(elsewhere, path.join(linked, ".claude-plugin"));
    expect(() => readPluginManifestDetailed(linked)).toThrow();
  });

  it("installs disabled, then contributes skills, commands, styles, hooks, MCP and LSP once approved", () => {
    const source = claudePlugin();
    const installed = installPlugin(source);
    expect(installed.manifest.id).toBe("cc-tools");
    const record = listPlugins(workspace).find((plugin) => plugin.id === "cc-tools");
    expect(record).toMatchObject({ status: "disabled", format: "claude", origin: { kind: "local" } });
    expect(record?.warnings?.length).toBeGreaterThan(0);
    expect(loadUserCommands(workspace).some((command) => command.plugin === "cc-tools")).toBe(false);

    setPluginEnabled("cc-tools", true);
    const contributions = loadPluginContributions(workspace);
    const installedRoot = fs.realpathSync(installed.path);
    expect(contributions.commandRoots).toEqual([{ plugin: "cc-tools", path: path.join(installedRoot, "commands") }]);
    expect(Object.keys(contributions.mcpServers)).toEqual(["cc-tools__local-server", "cc-tools__remote"]);
    expect(contributions.mcpServers["cc-tools__local-server"]?.command).toBe(`${installedRoot}/bin/server`);
    expect(contributions.hooks.preToolUse?.[0]?.command).toContain(`'${installedRoot}'`);
    expect(mergePluginLspServers(workspace, { mine: { command: "x" } }, contributions)).toEqual({
      plugin: { "cc-tools:foo": { command: "foo-ls", args: ["--stdio"], extensionToLanguage: { ".foo": "foolang" } } },
      user: { mine: { command: "x" } },
    });

    const skill = loadSkills(workspace, contributions).find((candidate) => candidate.id === "cc-skill");
    expect(skill).toMatchObject({
      scope: "global",
      source: { format: "frontmatter", root: "plugin", pluginRoot: installedRoot },
    });

    const commands = loadUserCommands(workspace, contributions);
    expect(commands.filter((command) => command.plugin === "cc-tools")).toEqual([
      expect.objectContaining({ name: "cc-tools:deploy", scope: "user", description: "Deploy it" }),
      expect.objectContaining({ name: "cc-tools:ops:status", scope: "user", description: "Show status" }),
    ]);
    // Without an explicit snapshot the enabled plugins are read from disk.
    expect(loadUserCommands(workspace).map((command) => command.name)).toContain("cc-tools:deploy");

    expect(listOutputStyles(workspace, contributions)).toContainEqual({
      name: "cc-tools:terse",
      kind: "custom",
      plugin: "cc-tools",
    });
    expect(resolveOutputStyle("cc-tools:terse", workspace, contributions)).toBe("Answer tersely.");
    expect(() => resolveOutputStyle("cc-tools:../terse", workspace, contributions)).toThrow(/Unknown output style/);
    expect(() => resolveOutputStyle("other:terse", workspace, contributions)).toThrow(/Unknown output style/);

    const entry = pluginSupplyChainReport(workspace).entries.find((candidate) => candidate.id === "cc-tools");
    expect(entry?.capabilities).toEqual(["skills", "agents", "commands", "output-styles", "mcp", "lsp", "hooks"]);

    // A changed file revokes every contribution, the translated ones included.
    fs.appendFileSync(path.join(installed.path, ".mcp.json"), " ");
    const changed = loadPluginContributions(workspace);
    expect(changed.commandRoots).toEqual([]);
    expect(changed.lspServers).toEqual({});
    expect(changed.mcpServers).toEqual({});
  });

  it("lets a user or project command shadow a plugin command of the same name", () => {
    const source = claudePlugin();
    installPlugin(source);
    setPluginEnabled("cc-tools", true);
    write(path.join(workspace, ".seekforge", "commands", "cc-tools", "deploy.md"), "project deploy\n");
    const deploy = loadUserCommands(workspace).find((command) => command.name === "cc-tools:deploy");
    expect(deploy).toMatchObject({ scope: "project", body: "project deploy\n" });
    expect(deploy?.plugin).toBeUndefined();
  });
});
