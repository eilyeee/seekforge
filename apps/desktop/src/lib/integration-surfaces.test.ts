import { describe, expect, it } from "vitest";
import type { Skill } from "../types";
import { compactToast } from "./compact-result";
import { expandSkillInvocation, filterCommands, skillComposerEntries, SKILL_COMMAND_PREFIX } from "./composer";
import { isRemotePluginSource } from "./plugin-source";
import {
  formatLines,
  parseDirectoryLines,
  parseDomainList,
  sandboxNetworkValue,
} from "../views/sandbox-settings-model";

const skill = (patch: Partial<Skill>): Skill => ({
  id: "review",
  scope: "project",
  name: "Review",
  description: "Review a diff",
  tags: [],
  triggers: [],
  priority: 0,
  enabled: true,
  risk: "low",
  ...patch,
});

describe("skills in the composer palette", () => {
  it("offers enabled, user-invocable skills and hides user-invocable:false ones", () => {
    const entries = skillComposerEntries([
      skill({ id: "review" }),
      skill({ id: "internal-helper", userInvocable: false }),
      skill({ id: "off", enabled: false }),
      skill({ id: "user-only", disableModelInvocation: true }),
      skill({ id: "Mixed_Case Name!" }),
      skill({ id: "***" }),
      skill({ id: "REVIEW" }),
    ]);
    expect(entries.map((entry) => entry.name)).toEqual([
      `${SKILL_COMMAND_PREFIX}review`,
      `${SKILL_COMMAND_PREFIX}user-only`,
      `${SKILL_COMMAND_PREFIX}mixed-case-name`,
    ]);
    expect(entries[2]!.skillId).toBe("Mixed_Case Name!");
    expect(entries[0]!.hint).toBe("(skill) Review a diff");
    // The palette matcher finds them like any other command.
    const commands = entries.map((entry) => ({ name: entry.name, hint: entry.hint, run: () => {} }));
    expect(filterCommands("skill:rev", commands)[0]!.name).toBe("skill:review");
  });

  it("caps a long description and wraps the SKILL.md for the draft", () => {
    const [entry] = skillComposerEntries([skill({ description: "x".repeat(200) })]);
    expect(entry!.hint.length).toBeLessThanOrEqual("(skill) ".length + 61);
    const draft = expandSkillInvocation("  # Review\nsteps  ");
    expect(draft).toContain("<skill>\n# Review\nsteps\n</skill>");
    expect(draft.endsWith("Task: ")).toBe(true);
  });
});

describe("plugin install sources", () => {
  it("asks before anything that downloads code", () => {
    for (const source of [
      "https://github.com/acme/kit.git",
      "https://example.com/kit.tar.gz",
      "ssh://git@host/org/kit.git",
      "git+https://host/kit.git",
      "git@github.com:acme/kit.git",
      "lint-kit@acme-market",
    ]) {
      expect(isRemotePluginSource(source), source).toBe(true);
    }
    for (const source of ["/abs/plugin", "./rel/plugin", "~/plugins/kit", "plugins/kit", "kit", "", "  "]) {
      expect(isRemotePluginSource(source), source).toBe(false);
    }
  });
});

describe("user-owned sandbox settings model", () => {
  it("keeps one directory per line, commas included", () => {
    expect(parseDirectoryLines(" /a,b \n\n~/libs\n/a,b\r\n")).toEqual(["/a,b", "~/libs"]);
    expect(formatLines(["/x", "/y"])).toBe("/x\n/y");
    expect(formatLines(undefined)).toBe("");
  });

  it("tells clearing the policy apart from an empty allowlist", () => {
    expect(parseDomainList("a.com, *.b.com\n a.com  c.com")).toEqual(["a.com", "*.b.com", "c.com"]);
    expect(sandboxNetworkValue(false, "a.com", "")).toBeNull();
    expect(sandboxNetworkValue(true, "", "")).toEqual({ allowedDomains: [] });
    expect(sandboxNetworkValue(true, "a.com", "bad.a.com")).toEqual({
      allowedDomains: ["a.com"],
      deniedDomains: ["bad.a.com"],
    });
  });
});

describe("manual compaction toast", () => {
  const t = (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}(${Object.values(vars).join("|")})` : key;

  it("says when nothing was compacted and surfaces hook notices", () => {
    expect(compactToast(null, t)).toBe("chat.compactNothing");
    expect(compactToast({ droppedTurns: 2 }, t)).toBe("chat.compactDone");
    expect(compactToast({ droppedTurns: 2, notices: ["saved", " ", "a", "b", "c"] }, t)).toBe(
      "chat.compactDone chat.compactNotices(saved · a · b (+1))",
    );
  });
});
