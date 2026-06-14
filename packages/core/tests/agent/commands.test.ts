import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCommandRoster,
  commandHasShellInjection,
  commandTakesArguments,
  expandShellInjections,
  expandUserCommand,
  loadUserCommands,
} from "../../src/agent/index.js";

function makeDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeCmd(dir: string, rel: string, content: string): void {
  const path = join(dir, rel);
  mkdirSync(join(dir, ".seekforge", "commands"), { recursive: true });
  writeFileSync(join(dir, ".seekforge", "commands", rel), content);
}

let workspace: string;
let home: string;
const savedHome = process.env.SEEKFORGE_HOME;

beforeEach(() => {
  workspace = makeDir("seekforge-cmd-ws-");
  home = makeDir("seekforge-cmd-home-");
  process.env.SEEKFORGE_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.SEEKFORGE_HOME;
  else process.env.SEEKFORGE_HOME = savedHome;
});

describe("loadUserCommands", () => {
  it("returns [] when no commands dirs exist", () => {
    expect(loadUserCommands(workspace)).toEqual([]);
  });

  it("loads a project command with description = first non-empty line", () => {
    writeCmd(workspace, "review.md", "\n\nReview the diff carefully\nmore body\n");
    const cmds = loadUserCommands(workspace);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({
      name: "review",
      description: "Review the diff carefully",
      scope: "project",
    });
    expect(cmds[0]!.body).toBe("\n\nReview the diff carefully\nmore body\n");
  });

  it("loads a user command honoring SEEKFORGE_HOME", () => {
    writeCmd(home, "ship.md", "ship it");
    const cmds = loadUserCommands(workspace);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ name: "ship", scope: "user", description: "ship it" });
  });

  it("de-dups by name, project winning over user", () => {
    writeCmd(workspace, "dup.md", "project version");
    writeCmd(home, "dup.md", "user version");
    writeCmd(home, "extra.md", "user only");
    const cmds = loadUserCommands(workspace);
    const dup = cmds.find((c) => c.name === "dup");
    expect(dup?.scope).toBe("project");
    expect(dup?.body).toBe("project version");
    expect(cmds.find((c) => c.name === "extra")?.scope).toBe("user");
    expect(cmds).toHaveLength(2);
  });

  it("ignores non-.md files and gives empty description for blank files", () => {
    writeCmd(workspace, "notes.txt", "ignored");
    writeCmd(workspace, "blank.md", "   \n\n");
    const cmds = loadUserCommands(workspace);
    expect(cmds.map((c) => c.name)).toEqual(["blank"]);
    expect(cmds[0]!.description).toBe("");
  });

  it("parses frontmatter: description, model, allowed-tools, argument-hint, stripped body", () => {
    writeCmd(
      workspace,
      "fix.md",
      [
        "---",
        "description: Fix a failing test",
        "model: deepseek-v4-pro",
        "allowed-tools: read_file, run_command",
        "argument-hint: <test name>",
        "---",
        "Fix $ARGUMENTS and re-run.",
      ].join("\n"),
    );
    const cmd = loadUserCommands(workspace)[0]!;
    expect(cmd).toMatchObject({
      name: "fix",
      description: "Fix a failing test",
      model: "deepseek-v4-pro",
      allowedTools: ["read_file", "run_command"],
      argumentHint: "<test name>",
    });
    expect(cmd.body).toBe("Fix $ARGUMENTS and re-run.");
  });

  it("parses disable-model-invocation: true and omits it otherwise", () => {
    writeCmd(
      workspace,
      "private.md",
      ["---", "disable-model-invocation: true", "---", "secret workflow"].join("\n"),
    );
    writeCmd(workspace, "open.md", ["---", "description: open", "---", "do it"].join("\n"));
    const cmds = loadUserCommands(workspace);
    expect(cmds.find((c) => c.name === "private")?.disableModelInvocation).toBe(true);
    expect(cmds.find((c) => c.name === "open")?.disableModelInvocation).toBeUndefined();
  });

  it("falls back to the first body line for description when frontmatter omits it", () => {
    writeCmd(workspace, "m.md", ["---", "model: deepseek-v4-pro", "---", "Do the thing"].join("\n"));
    const cmd = loadUserCommands(workspace)[0]!;
    expect(cmd.description).toBe("Do the thing");
    expect(cmd.model).toBe("deepseek-v4-pro");
    expect(cmd.allowedTools).toBeUndefined();
  });

  it("leaves a plain (no-frontmatter) command body untouched", () => {
    writeCmd(workspace, "plain.md", "\n\nReview the diff\nmore\n");
    const cmd = loadUserCommands(workspace)[0]!;
    expect(cmd.body).toBe("\n\nReview the diff\nmore\n");
    expect(cmd.model).toBeUndefined();
  });

  it("namespaces subdirectories with ':' (frontend/build.md → frontend:build)", () => {
    const sub = join(workspace, ".seekforge", "commands", "frontend");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "build.md"), "Build the frontend");
    writeCmd(workspace, "top.md", "Top-level");
    const names = loadUserCommands(workspace).map((c) => c.name).sort();
    expect(names).toEqual(["frontend:build", "top"]);
  });
});

describe("buildCommandRoster", () => {
  it("lists invocable commands (name + description), excluding disabled ones", () => {
    const roster = buildCommandRoster([
      { name: "review", description: "Review the diff", scope: "project", body: "x" },
      { name: "secret", description: "hidden", scope: "project", body: "y", disableModelInvocation: true },
      { name: "ship", description: "", scope: "user", body: "z" },
    ]);
    expect(roster).toBe("- review — Review the diff\n- ship");
  });

  it("returns '' when nothing is invocable", () => {
    expect(buildCommandRoster([])).toBe("");
    expect(
      buildCommandRoster([{ name: "x", description: "", scope: "project", body: "b", disableModelInvocation: true }]),
    ).toBe("");
  });
});

describe("commandTakesArguments", () => {
  it("is true for $ARGUMENTS or positional $1..$9, false otherwise", () => {
    expect(commandTakesArguments({ body: "Fix $ARGUMENTS now" })).toBe(true);
    expect(commandTakesArguments({ body: "Compare $1 with $2" })).toBe(true);
    expect(commandTakesArguments({ body: "Fix the build" })).toBe(false);
    expect(commandTakesArguments({ body: "Cost $0 or $x" })).toBe(false);
  });
});

describe("expandUserCommand", () => {
  it("replaces every $ARGUMENTS occurrence with the args", () => {
    expect(expandUserCommand({ body: "Review $ARGUMENTS and $ARGUMENTS" }, "the diff")).toBe(
      "Review the diff and the diff",
    );
  });

  it("replaces with empty string when args are empty", () => {
    expect(expandUserCommand({ body: "Run $ARGUMENTS tests" }, "")).toBe("Run  tests");
  });

  it("appends an Arguments line when there is no placeholder and args are given", () => {
    expect(expandUserCommand({ body: "Ship it" }, "v2")).toBe("Ship it\n\nArguments: v2");
  });

  it("returns the body unchanged when there is no placeholder and no args", () => {
    expect(expandUserCommand({ body: "Ship it" }, "")).toBe("Ship it");
  });

  it("fills positional $1..$9 from whitespace-split args", () => {
    expect(expandUserCommand({ body: "Compare $1 with $2" }, "main feature")).toBe(
      "Compare main with feature",
    );
  });

  it("leaves missing positionals empty and supports $1 + $ARGUMENTS together", () => {
    expect(expandUserCommand({ body: "First $1; all: $ARGUMENTS" }, "a b c")).toBe(
      "First a; all: a b c",
    );
    expect(expandUserCommand({ body: "Compare $1 with $2" }, "only")).toBe("Compare only with ");
  });
});

describe("shell injection", () => {
  it("detects only bodies with a !`cmd` injection", () => {
    expect(commandHasShellInjection("status: !`git status`")).toBe(true);
    expect(commandHasShellInjection("no injection here")).toBe(false);
    expect(commandHasShellInjection("just a `code span`")).toBe(false);
  });

  it("replaces each injection with the trimmed exec output, in order", async () => {
    const out = await expandShellInjections("branch=!`git branch` files=!`ls`", async (cmd) =>
      cmd === "git branch" ? "  main\n" : "a.ts b.ts\n",
    );
    expect(out).toBe("branch=main files=a.ts b.ts");
  });

  it("renders a failed exec inline without aborting the rest", async () => {
    const out = await expandShellInjections("x=!`boom` y=!`ok`", async (cmd) => {
      if (cmd === "boom") throw new Error("nope");
      return "done";
    });
    expect(out).toBe("x=[command failed: nope] y=done");
  });

  it("returns the text unchanged when there is no injection", async () => {
    const out = await expandShellInjections("nothing here", async () => "X");
    expect(out).toBe("nothing here");
  });
});
