import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { PermissionRule } from "@seekforge/shared";
import { acquireSessionLease, SessionBusyError } from "@seekforge/core";
import {
  addPermissionRule,
  describeRule,
  persistPermissionRule,
  ProjectAllowRuleError,
  projectConfigPath,
  readRulesFile,
  removePermissionRule,
  sameRule,
  setUserMcpServerTrusted,
  userConfigPath,
} from "../permission-store.js";
import { permissionResultForKey } from "../model.js";

/**
 * An approval that outlives the run has to land somewhere it will actually be
 * honored, and it has to be findable afterwards. Both are properties of the
 * file this writes, so they are tested against a real one.
 */

function fakeHome(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-home-")));
}

const RULE: PermissionRule = { action: "allow", tool: "run_command", match: "pnpm test" };

function read(home: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(userConfigPath(home), "utf8")) as Record<string, unknown>;
}

describe("persistPermissionRule", () => {
  it("writes to the user config, the only layer where an allow rule survives", () => {
    const home = fakeHome();
    const written = persistPermissionRule(RULE, home);
    // sanitizeProjectConfig strips allow rules from a repository layer, so a
    // rule written into the project would save and then never fire.
    expect(written).toBe(path.join(home, ".seekforge", "config.json"));
    expect(read(home).permissionRules).toEqual([RULE]);
  });

  it("keeps every other setting in the file", () => {
    const home = fakeHome();
    fs.mkdirSync(path.join(home, ".seekforge"));
    fs.writeFileSync(userConfigPath(home), JSON.stringify({ model: "deepseek-v4", apiKey: "sk-keep-me" }));
    persistPermissionRule(RULE, home);
    const doc = read(home);
    expect(doc.model).toBe("deepseek-v4");
    expect(doc.apiKey).toBe("sk-keep-me");
    expect(doc.permissionRules).toEqual([RULE]);
  });

  it("is idempotent: approving the same command twice does not grow the file", () => {
    const home = fakeHome();
    persistPermissionRule(RULE, home);
    persistPermissionRule({ ...RULE }, home);
    expect(read(home).permissionRules).toHaveLength(1);
  });

  it("appends beside existing rules rather than replacing them", () => {
    const home = fakeHome();
    const deny: PermissionRule = { action: "deny", tool: "run_command", match: "rm -rf" };
    fs.mkdirSync(path.join(home, ".seekforge"));
    fs.writeFileSync(userConfigPath(home), JSON.stringify({ permissionRules: [deny] }));
    persistPermissionRule(RULE, home);
    expect(read(home).permissionRules).toEqual([deny, RULE]);
  });

  it("refuses to write over a config it could not parse", () => {
    const home = fakeHome();
    fs.mkdirSync(path.join(home, ".seekforge"));
    fs.writeFileSync(userConfigPath(home), "{ this is not json");
    // Writing a fresh document here would silently delete every setting the
    // user has — a far worse outcome than one un-persisted approval.
    expect(() => persistPermissionRule(RULE, home)).toThrow();
    expect(fs.readFileSync(userConfigPath(home), "utf8")).toBe("{ this is not json");
  });

  it("renders the rule as the raw match, never a paraphrase", () => {
    expect(describeRule(RULE)).toBe("allow run_command: pnpm test");
    expect(describeRule({ action: "allow", tool: "web_search" })).toBe("allow web_search");
  });

  it("compares rules by what makes them the same rule", () => {
    expect(sameRule(RULE, { ...RULE })).toBe(true);
    expect(sameRule(RULE, { ...RULE, match: "pnpm build" })).toBe(false);
    expect(sameRule({ action: "allow", tool: "x" }, { action: "allow", tool: "x", match: "" })).toBe(true);
  });
});

describe("addPermissionRule / removePermissionRule", () => {
  function fakeProject(): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-proj-")));
  }

  it("edits the user file and the project file, keeping other keys", () => {
    const home = fakeHome();
    const projectPath = fakeProject();
    fs.mkdirSync(path.join(projectPath, ".seekforge"));
    fs.writeFileSync(projectConfigPath(projectPath), JSON.stringify({ model: "m", permissionRules: [{ bogus: 1 }] }));
    const deny: PermissionRule = { action: "deny", tool: "run_command", match: "rm -rf" };
    expect(addPermissionRule("user", RULE, { projectPath, home })).toBe(userConfigPath(home));
    expect(addPermissionRule("project", deny, { projectPath, home })).toBe(projectConfigPath(projectPath));
    addPermissionRule("project", { ...deny }, { projectPath, home });
    expect(read(home).permissionRules).toEqual([RULE]);
    const project = JSON.parse(fs.readFileSync(projectConfigPath(projectPath), "utf8")) as Record<string, unknown>;
    expect(project).toEqual({ model: "m", permissionRules: [{ bogus: 1 }, deny] });
    expect(readRulesFile(projectConfigPath(projectPath))).toEqual({ rules: [deny] });

    removePermissionRule("project", deny, { projectPath, home });
    expect(readRulesFile(projectConfigPath(projectPath)).rules).toEqual([]);
    removePermissionRule("user", RULE, { projectPath, home });
    expect(read(home)).not.toHaveProperty("permissionRules");
  });

  it("drops an empty match so the saved rule matches any call", () => {
    const home = fakeHome();
    addPermissionRule("user", { action: "ask", tool: "write_file", match: "" }, { projectPath: fakeProject(), home });
    expect(read(home).permissionRules).toEqual([{ action: "ask", tool: "write_file" }]);
  });

  it("refuses an allow rule in the project file", () => {
    const projectPath = fakeProject();
    expect(() => addPermissionRule("project", RULE, { projectPath, home: fakeHome() })).toThrow(ProjectAllowRuleError);
    expect(fs.existsSync(projectConfigPath(projectPath))).toBe(false);
  });

  it("will not touch the project file while a run owns the workspace", () => {
    const projectPath = fakeProject();
    const lease = acquireSessionLease(projectPath, "running-session");
    try {
      expect(() =>
        addPermissionRule("project", { action: "deny", tool: "x" }, { projectPath, home: fakeHome() }),
      ).toThrow(SessionBusyError);
    } finally {
      lease.release();
    }
  });

  it("reports an unreadable file instead of reading it as empty", () => {
    const home = fakeHome();
    fs.mkdirSync(path.join(home, ".seekforge"));
    fs.writeFileSync(userConfigPath(home), "{ nope");
    expect(readRulesFile(userConfigPath(home)).error).toBeDefined();
    expect(() => removePermissionRule("user", RULE, { projectPath: fakeProject(), home })).toThrow();
    expect(fs.readFileSync(userConfigPath(home), "utf8")).toBe("{ nope");
  });
});

describe("setUserMcpServerTrusted", () => {
  it("flips the trust flag of the user's own entry and keeps the rest of the file", () => {
    const home = fakeHome();
    fs.mkdirSync(path.join(home, ".seekforge"));
    const entry = { command: "npx", args: ["-y", "srv"], env: { TOKEN: "t" } };
    fs.writeFileSync(userConfigPath(home), JSON.stringify({ model: "m", mcpServers: { srv: entry } }));
    expect(setUserMcpServerTrusted("srv", true, { home, expected: { ...entry, trusted: false } })).toBe(
      userConfigPath(home),
    );
    expect(read(home)).toEqual({ model: "m", mcpServers: { srv: { ...entry, trusted: true } } });
    setUserMcpServerTrusted("srv", false, { home });
    expect(read(home).mcpServers).toEqual({ srv: { ...entry, trusted: false } });
  });

  it("refuses a name the file does not define, or defines differently from the running entry", () => {
    const home = fakeHome();
    fs.mkdirSync(path.join(home, ".seekforge"));
    fs.writeFileSync(
      userConfigPath(home),
      JSON.stringify({ mcpServers: { srv: { command: "npx", env: { TOKEN: "a" } } } }),
    );
    expect(() => setUserMcpServerTrusted("other", true, { home })).toThrow(/not defined/);
    // A --settings file shadows it with a different entry: nothing to flip here.
    expect(() =>
      setUserMcpServerTrusted("srv", true, { home, expected: { command: "npx", env: { TOKEN: "b" } } }),
    ).toThrow(/not defined/);
    expect(read(home).mcpServers).toEqual({ srv: { command: "npx", env: { TOKEN: "a" } } });
  });
});

describe("permission keys", () => {
  it("distinguishes the session grant from the durable one only by case", () => {
    expect(permissionResultForKey("y")).toBe(true);
    expect(permissionResultForKey("a")).toEqual({ allow: true, remember: "session" });
    expect(permissionResultForKey("A", true)).toEqual({ allow: true, remember: "always" });
    expect(permissionResultForKey("n")).toBe(false);
  });

  it("degrades a stray shift to the session grant when no rule was proposed", () => {
    // Core omits rememberRule for calls it will not grant durably; a frontend
    // must not turn a capital letter into a request the host has to invent.
    expect(permissionResultForKey("A", false)).toEqual({ allow: true, remember: "session" });
  });
});
