import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition, PluginRecord } from "@seekforge/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServerStatus } from "../agent/mcp-registry.js";
import { shortcutLines } from "../command-meta.js";
import type { KeyStroke } from "../keymap.js";
import { KEYMAP } from "../keymap.js";
import { agentRowLine, agentRows, agentsKey, type AgentsView } from "../manage/agents.js";
import { editLine, moveIndex } from "../manage/common.js";
import { hookRowLine, hookRows, hooksEmptyNote, hooksKey, type HooksView } from "../manage/hooks.js";
import { manageKey, withMessage } from "../manage/index.js";
import { mcpKey, mcpServerDetail, mcpServerLine, type McpView } from "../manage/mcp.js";
import { loadPermissionRows, permissionRowLine, permissionsKey, type PermissionsView } from "../manage/permissions.js";
import {
  disabledStoreSkills,
  pluginToggleRows,
  skillToggleCalls,
  skillToggleRows,
  toggleKey,
  toggleRowLine,
  type ToggleView,
} from "../manage/toggles.js";
import { chatReducer, initialState } from "../model.js";
import { initialTabs, tabsReducer } from "../tabs.js";

const key = (name: NonNullable<KeyStroke["name"]>, extra: Partial<KeyStroke> = {}): KeyStroke => ({
  input: "",
  name,
  ...extra,
});
const ch = (input: string): KeyStroke => ({ input });

function typeInto<V>(view: V, text: string, handler: (v: V, input: string, stroke: KeyStroke) => unknown): V {
  let next = view;
  for (const c of text) {
    const outcome = handler(next, c, ch(c)) as { kind: string; view: V };
    if (outcome.kind !== "update") throw new Error(`unexpected ${outcome.kind} on ${c}`);
    next = outcome.view;
  }
  return next;
}

describe("manage/common", () => {
  it("wraps list movement and edits one line", () => {
    expect(moveIndex(0, -1, 3)).toBe(2);
    expect(moveIndex(2, 8, 3)).toBe(1);
    expect(moveIndex(5, 1, 0)).toBe(0);
    expect(editLine("ab", "c", ch("c"))).toBe("abc");
    expect(editLine("ab", "", key("backspace"))).toBe("a");
    expect(editLine("ab", "", key("up"))).toBeUndefined();
    expect(editLine("ab", "x", { input: "x", ctrl: true })).toBeUndefined();
    expect(editLine("abc", "d", ch("d"), 3)).toBe("abc");
  });
});

describe("/permissions", () => {
  let project: string;
  let home: string;
  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "sf-perm-proj-")));
    home = realpathSync(mkdtempSync(join(tmpdir(), "sf-perm-home-")));
    mkdirSync(join(project, ".seekforge"));
    mkdirSync(join(home, ".seekforge"));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("lists rules by source, marks project allow rules as ignored, and ends with session grants", () => {
    writeFileSync(
      join(project, ".seekforge", "config.json"),
      JSON.stringify({
        permissionRules: [
          { action: "deny", tool: "run_command", match: "rm" },
          { action: "allow", tool: "*" },
        ],
        profiles: { strict: { permissionRules: [{ action: "ask", tool: "write_file" }] } },
      }),
    );
    writeFileSync(
      join(home, ".seekforge", "config.json"),
      JSON.stringify({ permissionRules: [{ action: "allow", tool: "run_command", match: "pnpm test" }] }),
    );
    const settings = join(home, "settings.json");
    writeFileSync(settings, JSON.stringify({ permissionRules: [{ action: "deny", tool: "web_fetch" }] }));
    const rows = loadPermissionRows({
      projectPath: project,
      home,
      settingsPath: settings,
      profile: "strict",
      sessionGrants: ["git status"],
    });
    expect(rows.map(permissionRowLine)).toEqual([
      "settings deny web_fetch",
      "profile  ask write_file",
      "project  deny run_command: rm",
      "project  allow * (ignored: a project file cannot allow)",
      "user     allow run_command: pnpm test",
      "session  allow run_command: git status (this session only)",
    ]);
  });

  it("reports a broken config file as a row", () => {
    writeFileSync(join(home, ".seekforge", "config.json"), "{ nope");
    const rows = loadPermissionRows({ projectPath: project, home, sessionGrants: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("problem");
  });

  const view: PermissionsView = {
    kind: "permissions",
    index: 0,
    rows: [
      { kind: "rule", source: "settings", path: "/s.json", rule: { action: "deny", tool: "x" } },
      { kind: "rule", source: "user", path: "/u.json", rule: { action: "allow", tool: "run_command", match: "ls" } },
      { kind: "grant", prefix: "git log" },
    ],
  };

  it("adds a rule through the form", () => {
    let v = (permissionsKey(view, "a", ch("a")) as { view: PermissionsView }).view;
    expect(v.draft).toMatchObject({ field: 0, action: "deny", scope: "user" });
    v = typeInto(v, "run_command", permissionsKey);
    v = (permissionsKey(v, "", key("tab")) as { view: PermissionsView }).view;
    v = (permissionsKey(v, "", key("right")) as { view: PermissionsView }).view; // deny → ask
    v = (permissionsKey(v, "", key("tab")) as { view: PermissionsView }).view;
    v = typeInto(v, "npm publish", permissionsKey);
    v = (permissionsKey(v, "", key("tab")) as { view: PermissionsView }).view;
    v = (permissionsKey(v, " ", ch(" ")) as { view: PermissionsView }).view; // user → project
    const saved = permissionsKey(v, "", key("return"));
    expect(saved).toMatchObject({
      kind: "effect",
      effect: {
        kind: "add-rule",
        scope: "project",
        rule: { action: "ask", tool: "run_command", match: "npm publish" },
      },
    });
    expect((saved as { view: PermissionsView }).view.draft).toBeUndefined();
  });

  it("refuses an empty tool and an allow rule for the project file", () => {
    const empty = permissionsKey(
      { ...view, draft: { field: 0, tool: " ", action: "deny", match: "", scope: "user" } },
      "",
      key("return"),
    );
    expect(empty).toMatchObject({ kind: "update", view: { message: { tone: "error" } } });
    const projectAllow = permissionsKey(
      { ...view, draft: { field: 0, tool: "x", action: "allow", match: "", scope: "project" } },
      "",
      key("return"),
    );
    expect((projectAllow as { view: PermissionsView }).view.message?.text).toMatch(/only deny or ask/);
  });

  it("deletes only editable rules, after a y", () => {
    const readOnly = permissionsKey(view, "d", ch("d"));
    expect((readOnly as { view: PermissionsView }).view.message?.text).toMatch(/read-only/);
    const user = { ...view, index: 1 };
    const asked = (permissionsKey(user, "d", ch("d")) as { view: PermissionsView }).view;
    expect(asked.confirmDelete).toBe(true);
    expect(permissionsKey(asked, "y", ch("y"))).toMatchObject({
      kind: "effect",
      effect: { kind: "delete-rule", scope: "user", rule: { action: "allow", tool: "run_command", match: "ls" } },
    });
    const declined = permissionsKey(asked, "n", ch("n"));
    expect((declined as { view: PermissionsView }).view.confirmDelete).toBeUndefined();
    const grant = permissionsKey({ ...view, index: 2 }, "d", ch("d"));
    expect((grant as { view: PermissionsView }).view.message?.tone).toBe("error");
    expect(permissionsKey(view, "", key("escape"))).toEqual({ kind: "close" });
  });
});

describe("/mcp", () => {
  const servers: McpServerStatus[] = [
    {
      name: "local",
      state: "connected",
      origin: "user",
      transport: "stdio",
      target: "node s.js",
      tools: 3,
      prompts: 1,
    },
    {
      name: "remote",
      state: "failed",
      origin: "user",
      transport: "http",
      target: "https://x.test/mcp",
      tools: 0,
      error: "401",
    },
    { name: "off", state: "untrusted", origin: "user", transport: "stdio", target: "npx off", tools: 0 },
    { name: "repo", state: "untrusted", origin: "repository", transport: "stdio", target: "sh evil.sh", tools: 0 },
    { name: "plug__x", state: "connected", origin: "plugin", transport: "stdio", target: "node p", tools: 1 },
  ];
  const view: McpView = { kind: "mcp", servers, index: 0 };
  const at = (index: number): McpView => ({ ...view, index });

  it("renders state, counts, and the raw target", () => {
    expect(mcpServerLine(servers[0]!)).toBe("● local  connected  (user, stdio) · 3 tools · 1 prompts");
    expect(mcpServerDetail(servers[1]!)).toEqual([
      "url: https://x.test/mcp",
      "error: 401",
      "OAuth login: seekforge mcp login remote",
    ]);
    expect(mcpServerDetail(servers[3]!)[1]).toMatch(/defined by this repository/);
  });

  it("reconnects, disables, and asks before enabling", () => {
    expect(mcpKey(view, "r", ch("r"))).toMatchObject({ kind: "effect", effect: { kind: "reconnect", name: "local" } });
    expect(mcpKey(view, "e", ch("e"))).toMatchObject({
      kind: "effect",
      effect: { kind: "set-enabled", name: "local", enabled: false },
    });
    const asked = mcpKey(at(2), "e", ch("e")) as { view: McpView };
    expect(asked.view.confirmEnable).toBe("off");
    expect(asked.view.message?.text).toContain("npx off");
    expect(mcpKey(asked.view, "y", ch("y"))).toMatchObject({
      kind: "effect",
      effect: { kind: "set-enabled", name: "off", enabled: true },
    });
    expect((mcpKey(asked.view, "x", ch("x")) as { view: McpView }).view.confirmEnable).toBeUndefined();
    expect((mcpKey(at(2), "r", ch("r")) as { view: McpView }).view.message?.tone).toBe("error");
  });

  it("never switches a repository or plugin server from here", () => {
    expect((mcpKey(at(3), "e", ch("e")) as { view: McpView }).view.message?.text).toMatch(/repository/);
    expect((mcpKey(at(4), " ", ch(" ")) as { view: McpView }).view.message?.text).toMatch(/plugin/);
  });

  it("copies the login command only for remote servers", () => {
    expect(mcpKey(at(1), "l", ch("l"))).toMatchObject({
      kind: "effect",
      effect: { kind: "copy-login", name: "remote" },
    });
    expect((mcpKey(view, "l", ch("l")) as { view: McpView }).view.message?.tone).toBe("dim");
  });

  it("updates async server rows without moving the selection", () => {
    const state = { ...initialState("m"), overlay: { kind: "manage" as const, view: at(3) } };
    const next = chatReducer(state, {
      type: "manage-mcp-servers",
      servers: servers.slice(0, 2),
      message: { text: "done", tone: "ok" },
    });
    expect(next.overlay).toEqual({
      kind: "manage",
      view: { ...at(1), servers: servers.slice(0, 2), message: { text: "done", tone: "ok" } },
    });
    // Another overlay replaced it meanwhile: the late result is dropped.
    const other = { ...initialState("m"), overlay: { kind: "context" as const } };
    expect(chatReducer(other, { type: "manage-mcp-servers", servers })).toBe(other);
    expect(
      chatReducer(
        { ...initialState("m"), overlay: { kind: "manage", view: { kind: "hooks", rows: [], index: 0 } } },
        { type: "manage-update", view },
      ).overlay,
    ).toEqual({ kind: "manage", view: { kind: "hooks", rows: [], index: 0 } });
  });
});

describe("/agents", () => {
  let project: string;
  let home: string;
  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "sf-agents-proj-")));
    home = realpathSync(mkdtempSync(join(tmpdir(), "sf-agents-home-")));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const def = (id: string, scope: AgentDefinition["scope"]): AgentDefinition => ({
    id,
    name: id,
    description: `${id} agent`,
    triggers: [],
    mode: "ask",
    scope,
  });

  it("offers a file to edit only where it exists", () => {
    mkdirSync(join(project, ".seekforge", "agents", "mine"), { recursive: true });
    writeFileSync(join(project, ".seekforge", "agents", "mine", "AGENT.md"), "---\nname: mine\n---\n");
    const rows = agentRows([def("reviewer", "builtin"), def("mine", "project"), def("from-plugin", "global")], {
      project,
      global: home,
    });
    expect(rows.map((r) => [r.id, r.path])).toEqual([
      ["reviewer", undefined],
      ["mine", join(project, ".seekforge", "agents", "mine", "AGENT.md")],
      ["from-plugin", undefined],
    ]);
    expect(agentRowLine(rows[2]!)).toContain("(ask, plugin/global)");
    const view: AgentsView = { kind: "agents", rows, index: 1 };
    expect(agentsKey(view, "e", ch("e"))).toMatchObject({ kind: "effect", effect: { kind: "edit-agent" } });
    expect((agentsKey({ ...view, index: 0 }, "", key("return")) as { view: AgentsView }).view.message?.text).toMatch(
      /built-in/,
    );
  });

  it("walks the wizard and validates before creating", () => {
    const view: AgentsView = { kind: "agents", rows: [], index: 0 };
    let v = (agentsKey(view, "n", ch("n")) as { view: AgentsView }).view;
    v = typeInto(v, "DB-Helper", agentsKey);
    expect(v.draft?.id).toBe("db-helper");
    v = (agentsKey(v, "", key("tab")) as { view: AgentsView }).view;
    v = typeInto(v, "Runs migrations", agentsKey);
    v = (agentsKey(v, "", key("tab")) as { view: AgentsView }).view;
    v = typeInto(v, "read_file, run_command", agentsKey);
    v = (agentsKey(v, "", key("tab")) as { view: AgentsView }).view;
    v = (agentsKey(v, "", key("right")) as { view: AgentsView }).view; // edit → ask
    v = (agentsKey(v, "", key("tab")) as { view: AgentsView }).view;
    v = typeInto(v, "deepseek-v4-pro", agentsKey);
    v = (agentsKey(v, "", key("tab")) as { view: AgentsView }).view;
    v = (agentsKey(v, " ", ch(" ")) as { view: AgentsView }).view; // project → global
    expect(agentsKey(v, "", key("return"))).toMatchObject({
      kind: "effect",
      effect: {
        kind: "create-agent",
        scope: "global",
        definition: {
          id: "db-helper",
          description: "Runs migrations",
          mode: "ask",
          tools: ["read_file", "run_command"],
          model: "deepseek-v4-pro",
        },
      },
    });
    const bad = agentsKey({ ...v, draft: { ...v.draft!, description: "" } }, "", key("return"));
    expect((bad as { view: AgentsView }).view.message?.tone).toBe("error");
    expect((agentsKey(v, "", key("escape")) as { view: AgentsView }).view.draft).toBeUndefined();
  });
});

describe("/hooks", () => {
  it("lists every stage with its entries, config first", () => {
    const rows = hookRows(
      { preToolUse: [{ command: "check.sh", match: "run_command" }], stop: [{ command: "notify", pattern: "x+" }] },
      { preToolUse: [{ command: "plugin.sh", type: "prompt" }] },
    );
    const lines = rows.map(hookRowLine);
    expect(lines.slice(0, 3)).toEqual([
      "── preToolUse (2) ──",
      "  run_command      command  check.sh",
      "  *                prompt   plugin.sh  [plugin]",
    ]);
    expect(lines).toContain("  /x+/             command  notify");
    expect(hooksEmptyNote(rows)).toBeUndefined();
    expect(hooksEmptyNote(hookRows(undefined, undefined))).toMatch(/no hooks/);
    const view: HooksView = { kind: "hooks", rows, index: 0 };
    expect(hooksKey(view, "e", ch("e"))).toMatchObject({ kind: "effect", effect: { kind: "edit-user-config" } });
    expect(manageKey(view, "q", ch("q"))).toEqual({ kind: "close" });
    expect(withMessage(view, "saved").message).toEqual({ text: "saved", tone: "ok" });
  });
});

describe("/skills and /plugins", () => {
  let project: string;
  let home: string;
  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "sf-skills-proj-")));
    home = realpathSync(mkdtempSync(join(tmpdir(), "sf-skills-home-")));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps a disabled store skill listed so it can be switched back on", () => {
    const dir = join(project, ".seekforge", "skills", "local-lint");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# lint");
    writeFileSync(join(dir, "skill.json"), JSON.stringify({ id: "local-lint", enabled: false, description: "Lint" }));
    const marker = join(project, ".seekforge", "skills", "some-builtin");
    mkdirSync(marker, { recursive: true });
    writeFileSync(join(marker, "skill.json"), JSON.stringify({ id: "some-builtin", enabled: false }));
    const disabled = disabledStoreSkills(project, home);
    expect(disabled).toEqual([{ id: "local-lint", scope: "project", disabled: true, description: "Lint" }]);
    const rows = skillToggleRows([{ id: "tdd", scope: "builtin", description: "Tests first" }], disabled);
    expect(rows.map((r) => toggleRowLine("skills", r))).toEqual([
      "[x] tdd  (builtin)  Tests first",
      "[ ] local-lint  (project)  Lint",
    ]);
    const view: ToggleView = { kind: "skills", rows, index: 1 };
    expect(toggleKey(view, " ", ch(" "))).toMatchObject({
      kind: "effect",
      effect: { kind: "set-skill", id: "local-lint", enabled: true, scope: "project" },
    });
  });

  it("switches a builtin with a project marker, and clears both layers to re-enable it", () => {
    expect(skillToggleCalls("tdd", "project", true)).toEqual([{ global: false }]);
    expect(skillToggleCalls("x", "global", false)).toEqual([{ global: true }]);
    expect(skillToggleCalls("no-such-builtin", "builtin", false)).toEqual([{ global: false }]);
  });

  it("asks before enabling a plugin and refuses repository or invalid ones", () => {
    const record = (over: Partial<PluginRecord>): PluginRecord => ({
      id: "p",
      scope: "global",
      path: "/x",
      status: "disabled",
      manifest: {
        apiVersion: 1,
        id: "p",
        name: "p",
        version: "1.0.0",
        contributes: { hooks: { preToolUse: [{ command: "x" }] }, mcpServers: { s: { command: "y" } } },
      },
      ...over,
    });
    const rows = pluginToggleRows([
      record({}),
      record({ id: "on", status: "enabled" }),
      record({ id: "repo", scope: "project", status: "review_required" }),
      record({ id: "bad", status: "invalid", error: "manifest missing" }),
    ]);
    expect(toggleRowLine("plugins", rows[0]!)).toBe("[ ] p  (global)  disabled  {mcp, hooks}");
    const view: ToggleView = { kind: "plugins", rows, index: 0 };
    const asked = toggleKey(view, "", key("return")) as { view: ToggleView };
    expect(asked.view.confirmEnable).toBe("p");
    expect(asked.view.message?.text).toMatch(/mcp, hooks/);
    expect(toggleKey(asked.view, "y", ch("y"))).toMatchObject({
      kind: "effect",
      effect: { kind: "set-plugin", id: "p", enabled: true },
    });
    expect(toggleKey({ ...view, index: 1 }, " ", ch(" "))).toMatchObject({
      effect: { kind: "set-plugin", id: "on", enabled: false },
    });
    expect((toggleKey({ ...view, index: 2 }, " ", ch(" ")) as { view: ToggleView }).view.message?.text).toMatch(
      /plugin install/,
    );
    expect((toggleKey({ ...view, index: 3 }, " ", ch(" ")) as { view: ToggleView }).view.message?.tone).toBe("error");
  });
});

describe("help shortcuts and tab seeding", () => {
  it("lists the effective bindings, chords included", () => {
    const lines = shortcutLines([
      ...KEYMAP,
      {
        scope: "composer",
        key: { input: "x", ctrl: true },
        rest: [{ input: "e", ctrl: true }],
        action: "external-editor",
      },
    ]);
    expect(lines[0]).toBe("── Keyboard shortcuts ──");
    expect(lines.find((l) => l.includes("edit the prompt in $EDITOR"))).toMatch(/ctrl\+g \/ ctrl\+x ctrl\+e/);
    expect(lines.find((l) => l.includes("open the model picker"))).toMatch(/alt\+p/);
    expect(lines.find((l) => l.includes("toggle thinking mode"))).toMatch(/alt\+t/);
    // An action with no binding is not listed.
    expect(lines.some((l) => l.includes("jump to the latest message"))).toBe(false);
  });

  it("starts tabs in the launch approval mode", () => {
    const tabs = initialTabs("m", { approval: "plan", verbose: true });
    expect(tabs.tabs[0]?.chat).toMatchObject({ approval: "plan", verbose: true });
    const more = tabsReducer(tabs, { type: "tab-new", model: "m", approval: "plan" });
    expect(more.tabs[1]?.chat).toMatchObject({ approval: "plan", verbose: false });
    expect(initialTabs("m").tabs[0]?.chat.approval).toBe("confirm");
  });
});
