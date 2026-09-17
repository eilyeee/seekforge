import * as fs from "node:fs";
import * as path from "node:path";
import type { PermissionRule } from "@seekforge/shared";
import { describe, expect, it } from "vitest";
import {
  buildSkillListing,
  clearSkillSignalCache,
  createSkillSession,
  expandSkillBody,
  invocableSkills,
  mapToolName,
  splitSkillArguments,
  translateToolRules,
} from "../../src/skills/index.js";
import { hookMatcherTools, splitToolList } from "../../src/skills/tool-rules.js";
import { skillForkDefinition } from "../../src/skills/invocation.js";
import { BUILTIN_AGENTS } from "../../src/subagents/builtins.js";
import { makeSkill, makeTempDir } from "./helpers.js";

describe("tool rule translation", () => {
  it("splits comma and space separated lists without breaking parentheses", () => {
    expect(splitToolList("Read, Grep Bash(git add:*) Bash(git commit -m:*)")).toEqual([
      "Read",
      "Grep",
      "Bash(git add:*)",
      "Bash(git commit -m:*)",
    ]);
  });

  it("maps Claude Code names and keeps SeekForge and MCP names", () => {
    expect(mapToolName("Bash")).toEqual(["run_command"]);
    expect(mapToolName("Read")).toEqual(["read_file", "notebook_read"]);
    expect(mapToolName("glob")).toEqual(["glob"]);
    expect(mapToolName("Glob")).toEqual(["glob", "list_files"]);
    expect(mapToolName("mcp__srv__tool")).toEqual(["mcp__srv__tool"]);
    expect(mapToolName("Teleport")).toEqual([]);
  });

  it("translates allow entries exactly or not at all", () => {
    const { rules, notes } = translateToolRules(
      [
        "Bash(git log:*)",
        "Bash(npm test)",
        "run_command(pnpm lint)",
        "Edit(docs/**)",
        "Read(*.ts)",
        "Bash(* --version)",
        "Frobnicate",
        "WebFetch",
      ],
      "allow",
    );
    expect(rules).toEqual<PermissionRule[]>([
      { action: "allow", tool: "run_command", match: "git log" },
      { action: "allow", tool: "run_command", match: "pnpm lint" },
      { action: "allow", tool: "apply_patch", match: "docs/" },
      { action: "allow", tool: "web_fetch" },
    ]);
    expect(notes).toEqual([
      expect.stringContaining('"Bash(npm test)" cannot be expressed exactly'),
      expect.stringContaining('"Read(*.ts)" cannot be expressed exactly'),
      expect.stringContaining('"Read(*.ts)" cannot be expressed exactly'),
      expect.stringContaining('"Bash(* --version)" cannot be expressed exactly'),
      expect.stringContaining('unknown tool "Frobnicate"'),
    ]);
  });

  it("widens deny entries it cannot express and adds absolute path twins", () => {
    const { rules } = translateToolRules(["Bash(npm publish)", "Write(secrets/**)", "Read(~/.ssh)"], "deny", "/ws");
    expect(rules).toEqual<PermissionRule[]>([
      { action: "deny", tool: "run_command" },
      { action: "deny", tool: "write_file", match: "secrets/" },
      { action: "deny", tool: "write_file", match: "/ws/secrets/" },
      { action: "deny", tool: "read_file" },
      { action: "deny", tool: "notebook_read" },
    ]);
  });

  it("refuses path specs that climb out of the workspace", () => {
    expect(translateToolRules(["Edit(../outside)"], "allow").rules).toEqual([]);
    expect(translateToolRules(["Edit(../outside)"], "deny").rules).toEqual([{ action: "deny", tool: "apply_patch" }]);
  });

  it("translates plain hook matchers and refuses regexes", () => {
    expect(hookMatcherTools(undefined)).toEqual(["*"]);
    expect(hookMatcherTools("Write|Edit")).toEqual(["write_file", "apply_patch"]);
    expect(hookMatcherTools("mcp__github__create_issue")).toEqual(["mcp__github__create_issue"]);
    expect(hookMatcherTools("Notebook.*")).toBeUndefined();
    expect(hookMatcherTools("Teleport")).toBeUndefined();
  });
});

describe("expandSkillBody", () => {
  const context = { workspace: "/ws", sessionId: "s-1" };

  it("splits arguments like a shell", () => {
    expect(splitSkillArguments(`one "two words" 'three' ""`)).toEqual(["one", "two words", "three", ""]);
  });

  it("substitutes whole, indexed, positional and named arguments in one pass", () => {
    const skill = makeSkill("s", {
      content: "all=$ARGUMENTS first=$ARGUMENTS[0] second=$1 file=$file mode=$mode missing=$ARGUMENTS[5] $other",
      argumentNames: ["file", "mode"],
    });
    const { text } = expandSkillBody(skill, 'a.ts "$1 literal"', context);
    expect(text).toBe(
      'all=a.ts "$1 literal" first=a.ts second=$1 literal file=a.ts mode=$1 literal missing=$ARGUMENTS[5] $other',
    );
  });

  it("leaves a price alone and appends arguments when the body has no placeholder", () => {
    const skill = makeSkill("s", { content: "It costs $5." });
    expect(expandSkillBody(skill, "ship it", context).text).toBe("It costs $5.\n\nARGUMENTS: ship it");
    expect(expandSkillBody(skill, "", context).text).toBe("It costs $5.");
  });

  it("resolves the Claude Code path variables and flags unexpanded shell blocks", () => {
    const skill = makeSkill("s", {
      content:
        "run ${CLAUDE_SKILL_DIR}/x.sh in ${CLAUDE_PROJECT_DIR} (${CLAUDE_SESSION_ID}) ${CLAUDE_PLUGIN_ROOT} !`date`",
      dir: "/skills/s",
    });
    const expanded = expandSkillBody(skill, "", context);
    expect(expanded.text).toBe("run /skills/s/x.sh in /ws (s-1) ${CLAUDE_PLUGIN_ROOT} !`date`");
    expect(expanded.unexpandedShell).toBe(true);
    const pluginSkill = makeSkill("p", {
      content: "${CLAUDE_PLUGIN_ROOT}/bin",
      source: { format: "frontmatter", root: "plugin", pluginRoot: "/plugins/p" },
    });
    expect(expandSkillBody(pluginSkill, "", context).text).toBe("/plugins/p/bin");
  });
});

describe("skill session", () => {
  const base = { workspace: "/ws", mode: "edit" as const };

  it("applies a user skill's allow and deny rules to this run's policy only", () => {
    const shared: PermissionRule[] = [{ action: "deny", tool: "git_commit" }];
    const policy: { rules?: PermissionRule[] } = { rules: shared };
    const skill = makeSkill("u", {
      scope: "global",
      allowedTools: ["Bash(pnpm test:*)"],
      disallowedTools: ["Write"],
    });
    const session = createSkillSession({ ...base, skills: [skill], policy });
    const activation = session.activate(skill, "", { inline: true });
    expect(activation.rules).toEqual([
      { action: "deny", tool: "write_file" },
      { action: "allow", tool: "run_command", match: "pnpm test" },
    ]);
    expect(policy.rules).toEqual([shared[0], ...activation.rules]);
    // The configured array is never mutated in place.
    expect(shared).toHaveLength(1);
    expect(session.activeRules()).toEqual(activation.rules);
  });

  it("never lets a project skill pre-approve, but still lets it restrict", () => {
    const policy: { rules?: PermissionRule[] } = {};
    const skill = makeSkill("p", { scope: "project", allowedTools: ["Bash"], disallowedTools: ["WebFetch"] });
    const session = createSkillSession({ ...base, skills: [skill], policy });
    const activation = session.activate(skill, "", { inline: true });
    expect(policy.rules).toEqual([{ action: "deny", tool: "web_fetch" }]);
    expect(activation.notes).toContain(
      "allowed-tools was not applied: a project skill may restrict tools but never pre-approve them",
    );
  });

  it("reports a repeat load, reloads on request, and never repeats rules", () => {
    const policy: { rules?: PermissionRule[] } = {};
    const skill = makeSkill("r", { scope: "builtin", disallowedTools: ["Write"] });
    const session = createSkillSession({ ...base, skills: [skill], policy });
    expect(session.activate(skill, "x", { inline: true }).alreadyLoaded).toBe(false);
    expect(session.activate(skill, " x ", { inline: true }).alreadyLoaded).toBe(true);
    expect(session.activate(skill, "y", { inline: true }).alreadyLoaded).toBe(false);
    expect(session.activate(skill, "x", { inline: true, reload: true }).alreadyLoaded).toBe(false);
    expect(policy.rules).toEqual([{ action: "deny", tool: "write_file" }]);
    // Forks are real work and always run.
    expect(session.activate(skill, "x", { inline: false }).alreadyLoaded).toBe(false);
  });

  it("queues a model switch only when the host can make one, and notes effort", () => {
    const skill = makeSkill("m", { model: "pro", effort: "max" });
    const able = createSkillSession({ ...base, skills: [skill], policy: {}, canSwitchModel: true });
    expect(able.activate(skill, "", { inline: true }).notes).toEqual([
      "the rest of this run uses model pro",
      "effort max was not applied: this host cannot change reasoning effort mid-run",
    ]);
    expect(able.takeModelRequest()).toBe("pro");
    expect(able.takeModelRequest()).toBeUndefined();
    const unable = createSkillSession({ ...base, skills: [skill], policy: {} });
    expect(unable.activate(skill, "", { inline: true }).notes[0]).toMatch(/cannot switch models/);
    expect(unable.takeModelRequest()).toBeUndefined();
  });

  it("reads a lazy skill source once", () => {
    let calls = 0;
    const session = createSkillSession({
      ...base,
      policy: {},
      skills: () => {
        calls++;
        return [makeSkill("lazy")];
      },
    });
    expect(calls).toBe(0);
    expect(session.skills.map((skill) => skill.id)).toEqual(["lazy"]);
    expect(session.skills).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it("picks the fork agent under a skill-specific id", () => {
    const session = { agents: BUILTIN_AGENTS, mode: "ask" as const };
    const adHoc = skillForkDefinition(makeSkill("f", { context: "fork", scope: "project" }), session);
    expect(adHoc.definition).toMatchObject({ id: "skill:f", mode: "ask", scope: "project" });
    const explore = skillForkDefinition(makeSkill("f", { context: "fork", agent: "Explore", model: "m" }), session);
    expect(explore.definition).toMatchObject({ id: "skill:f", mode: "ask", model: "m" });
    expect(explore.definition?.name).toContain("skill f");
    expect(skillForkDefinition(makeSkill("f", { agent: "ghost" }), session).error).toMatch(/not available/);
  });
});

describe("skill listing", () => {
  it("lists only what the model may invoke, project first", () => {
    const ws = makeTempDir();
    fs.writeFileSync(path.join(ws, "app.py"), "");
    clearSkillSignalCache();
    const skills = [
      makeSkill("b-builtin"),
      makeSkill("a-project", { scope: "project", whenToUse: "when asked", argumentHint: "[file]" }),
      makeSkill("manual", { disableModelInvocation: true }),
      makeSkill("risky", { risk: "high" }),
      makeSkill("off", { enabled: false }),
      makeSkill("py-only", { paths: ["**/*.py"] }),
      makeSkill("go-only", { paths: ["**/*.go"] }),
      makeSkill("forked", { scope: "global", context: "fork" }),
    ];
    const invocable = invocableSkills(skills, ws);
    expect(invocable.map((skill) => skill.id)).toEqual(["a-project", "forked", "b-builtin", "py-only"]);
    const listing = buildSkillListing(invocable, { preloaded: new Set(["b-builtin"]) });
    expect(listing?.split("\n")).toEqual([
      "- a-project: description of a-project when asked (args: [file])",
      "- forked: description of forked (runs in a subagent)",
      "- b-builtin: description of b-builtin (excerpt already above)",
      "- py-only: description of py-only",
    ]);
    expect(invocableSkills(skills, undefined).some((skill) => skill.id === "py-only")).toBe(false);
  });

  it("shortens every summary before dropping any entry, and counts what it drops", () => {
    const long = "x".repeat(2_000);
    const skills = Array.from({ length: 5 }, (_, index) => makeSkill(`s${index}`, { description: long }));
    const clipped = buildSkillListing(skills, { maxChars: 1_000 })!;
    expect(clipped.split("\n")).toHaveLength(5);
    expect(clipped.length).toBeLessThanOrEqual(1_000);
    expect(clipped).toContain("…");
    const many = Array.from({ length: 20 }, (_, index) => makeSkill(`s${index}`));
    const namesOnly = buildSkillListing(many, { maxChars: 60 })!;
    expect(namesOnly.split("\n")).toEqual(["- s0", "- s1", "- s2", "- s3", "- s4", "- … 15 more skill(s) not listed"]);
    expect(namesOnly.length).toBeLessThanOrEqual(60);
    expect(buildSkillListing([], {})).toBeUndefined();
  });
});
