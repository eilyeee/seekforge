import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  customCommandSpecs,
  expandCustomCommand,
  loadCustomCommands,
  type CustomCommand,
} from "../custom-commands.js";

let workspace: string;
let home: string;

function write(root: string, name: string, content: string): void {
  const dir = path.join(root, ".seekforge", "commands");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-cc-ws-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-cc-home-"));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe("loadCustomCommands", () => {
  it("returns [] when no commands directories exist", () => {
    expect(loadCustomCommands(workspace, home)).toEqual([]);
  });

  it("loads project and global commands with scopes", () => {
    write(workspace, "review.md", "Review the diff.");
    write(home, "tidy.md", "Tidy the code.");
    const cmds = loadCustomCommands(workspace, home);
    expect(cmds).toHaveLength(2);
    expect(cmds.find((c) => c.name === "review")?.scope).toBe("project");
    expect(cmds.find((c) => c.name === "tidy")?.scope).toBe("global");
  });

  it("project wins on a name clash", () => {
    write(workspace, "deploy.md", "Project deploy.");
    write(home, "deploy.md", "Global deploy.");
    const cmds = loadCustomCommands(workspace, home);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]?.scope).toBe("project");
    expect(cmds[0]?.body).toBe("Project deploy.");
  });

  it("parses frontmatter description and strips the fences from the body", () => {
    write(workspace, "fix.md", "---\ndescription: Fix a bug end to end\n---\nFind and fix: $ARGUMENTS");
    const [cmd] = loadCustomCommands(workspace, home);
    expect(cmd?.description).toBe("Fix a bug end to end");
    expect(cmd?.body).toBe("Find and fix: $ARGUMENTS");
  });

  it("falls back to the first body line capped at 60 chars when no frontmatter", () => {
    const long = "x".repeat(80);
    write(workspace, "long.md", `${long}\nrest of the prompt`);
    const [cmd] = loadCustomCommands(workspace, home);
    expect(cmd?.description.length).toBe(60);
    expect(cmd?.body.startsWith(long)).toBe(true);
  });

  it("sanitizes filenames into [a-z0-9-] names and ignores non-md files", () => {
    write(workspace, "My Cool_Cmd.md", "body");
    write(workspace, "notes.txt", "not a command");
    const cmds = loadCustomCommands(workspace, home);
    expect(cmds.map((c) => c.name)).toEqual(["my-cool-cmd"]);
  });
});

describe("expandCustomCommand", () => {
  const withPlaceholder: CustomCommand = {
    name: "fix",
    description: "fix",
    body: "Fix $ARGUMENTS now. Again: $ARGUMENTS",
    scope: "project",
  };
  const plain: CustomCommand = { name: "go", description: "go", body: "Just go.", scope: "global" };

  it("replaces every $ARGUMENTS occurrence", () => {
    expect(expandCustomCommand(withPlaceholder, "issue #7")).toBe(
      "Fix issue #7 now. Again: issue #7",
    );
  });

  it("replaces $ARGUMENTS with empty string when no args given", () => {
    expect(expandCustomCommand(withPlaceholder, "")).toBe("Fix  now. Again: ");
  });

  it("appends an Arguments section when there is no placeholder", () => {
    expect(expandCustomCommand(plain, "fast")).toBe("Just go.\n\nArguments: fast");
  });

  it("returns the body untouched without placeholder and without args", () => {
    expect(expandCustomCommand(plain, "")).toBe("Just go.");
  });
});

describe("customCommandSpecs", () => {
  it("emits palette rows with (custom) prefix and [args] hint only for $ARGUMENTS bodies", () => {
    const specs = customCommandSpecs([
      { name: "fix", description: "fix a bug", body: "Fix $ARGUMENTS", scope: "project" },
      { name: "go", description: "just go", body: "Just go.", scope: "global" },
    ]);
    expect(specs).toEqual([
      { name: "fix", args: "[args]", summary: "(custom) fix a bug" },
      { name: "go", summary: "(custom) just go" },
    ]);
  });
});
