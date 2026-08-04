import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { PermissionRule } from "@seekforge/shared";
import { describeRule, persistPermissionRule, sameRule, userConfigPath } from "../permission-store.js";
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
