import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadUserCommands } from "../../src/agent/index.js";

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
});
