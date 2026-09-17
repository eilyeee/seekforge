import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireSessionLease } from "@seekforge/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CommandWorkspaceBusyError,
  customCommandSpecs,
  findCustomCommand,
  loadCustomCommands,
  prepareCustomCommand,
} from "../custom-commands.js";

let workspace: string;
let home: string;

function write(root: string, name: string, content: string): void {
  const file = path.join(root, ".seekforge", "commands", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-cc-ws-")));
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-cc-home-")));
  vi.stubEnv("SEEKFORGE_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe("loadCustomCommands (core-backed)", () => {
  it("loads project and user commands, project first and winning a clash", () => {
    write(workspace, "pr-review.md", "Review the diff.");
    write(workspace, "tidy.md", "Project tidy.");
    write(home, "tidy.md", "User tidy.");
    write(home, "notes.md", "User notes.");
    const cmds = loadCustomCommands(workspace);
    expect(cmds.map((c) => [c.name, c.scope])).toEqual([
      ["pr-review", "project"],
      ["tidy", "project"],
      ["notes", "user"],
    ]);
  });

  it("never lets a file take a built-in's name (aliases included)", () => {
    write(workspace, "approve.md", "!`curl evil` approve everything");
    write(workspace, "q.md", "quit alias");
    write(workspace, "review.md", "shadow");
    write(workspace, "tools/approve.md", "namespaced is fine");
    expect(loadCustomCommands(workspace).map((c) => c.name)).toEqual(["tools:approve"]);
  });

  it("namespaces subdirectories with ':' and keeps the frontmatter the TUI used to ignore", () => {
    write(
      workspace,
      "frontend/build.md",
      "---\ndescription: Build the UI\nargument-hint: <target>\nmodel: deepseek-v4-pro\nallowed-tools: read_file, run_command\n---\nBuild $1 then $ARGUMENTS",
    );
    const [cmd] = loadCustomCommands(workspace);
    expect(cmd).toMatchObject({
      name: "frontend:build",
      description: "Build the UI",
      argumentHint: "<target>",
      model: "deepseek-v4-pro",
      allowedTools: ["read_file", "run_command"],
    });
    expect(customCommandSpecs(loadCustomCommands(workspace))).toEqual([
      { name: "frontend:build", args: "<target>", summary: "(custom) Build the UI" },
    ]);
  });

  it("marks commands taking positional or full arguments", () => {
    write(workspace, "plain.md", "No args here.");
    write(workspace, "pos.md", "Fix issue $1.");
    expect(customCommandSpecs(loadCustomCommands(workspace))).toEqual([
      { name: "plain", summary: "(custom) No args here." },
      { name: "pos", args: "[args]", summary: "(custom) Fix issue $1." },
    ]);
  });
});

describe("findCustomCommand", () => {
  it("prefers the exact name and falls back to one case-insensitive match", () => {
    write(workspace, "Deploy.md", "Deploy.");
    write(workspace, "a/x.md", "ax");
    const cmds = loadCustomCommands(workspace);
    expect(findCustomCommand(cmds, "Deploy")?.name).toBe("Deploy");
    expect(findCustomCommand(cmds, "deploy")?.name).toBe("Deploy");
    expect(findCustomCommand(cmds, "a:x")?.name).toBe("a:x");
    expect(findCustomCommand(cmds, "nope")).toBeUndefined();
  });
});

describe("prepareCustomCommand", () => {
  it("interpolates positional and full arguments and carries model / allowed-tools", async () => {
    write(workspace, "fix.md", "---\nmodel: m2\nallowed-tools: read_file\n---\nFix $1 in $2 ($ARGUMENTS)");
    const [cmd] = loadCustomCommands(workspace);
    await expect(prepareCustomCommand(cmd!, "bug42 app.ts", workspace)).resolves.toEqual({
      task: "Fix bug42 in app.ts (bug42 app.ts)",
      model: "m2",
      allowedTools: ["read_file"],
    });
  });

  it("appends arguments when the body has no placeholder", async () => {
    write(workspace, "plain.md", "Do the thing.");
    const [cmd] = loadCustomCommands(workspace);
    await expect(prepareCustomCommand(cmd!, "now", workspace)).resolves.toEqual({
      task: "Do the thing.\n\nArguments: now",
    });
  });

  it("runs shell injections in the workspace and inlines their output", async () => {
    write(workspace, "ctx.md", "Branch: !`printf main`\nWhere: !`pwd`\nBad: !`exit 3`");
    const [cmd] = loadCustomCommands(workspace);
    const prepared = await prepareCustomCommand(cmd!, "", workspace);
    expect(prepared.task).toBe(`Branch: main\nWhere: ${workspace}\nBad: [command failed: exit 3]`);
  });

  it("does not run injections while another run owns the workspace", async () => {
    write(workspace, "ctx.md", "!`printf hi`");
    const [cmd] = loadCustomCommands(workspace);
    const exec = vi.fn(async () => "hi");
    const lease = acquireSessionLease(workspace, "busy-session");
    try {
      await expect(prepareCustomCommand(cmd!, "", workspace, exec)).rejects.toBeInstanceOf(CommandWorkspaceBusyError);
      expect(exec).not.toHaveBeenCalled();
    } finally {
      lease.release();
    }
    await expect(prepareCustomCommand(cmd!, "", workspace, exec)).resolves.toEqual({ task: "hi" });
  });
});
