import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

function writeCmd(dir: string, rel: string, content: string): void {
  mkdirSync(join(dir, ".seekforge", "commands"), { recursive: true });
  writeFileSync(join(dir, ".seekforge", "commands", rel), content);
}

describe("run_user_command tool", () => {
  let workspace: string;
  let home: string;
  const savedHome = process.env.SEEKFORGE_HOME;
  const dispatcher = createDefaultDispatcher();

  beforeEach(() => {
    workspace = makeWorkspace();
    home = makeWorkspace();
    process.env.SEEKFORGE_HOME = home;
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.SEEKFORGE_HOME;
    else process.env.SEEKFORGE_HOME = savedHome;
  });

  it("expands a normal command with its arguments", async () => {
    writeCmd(workspace, "review.md", "Review $ARGUMENTS carefully");
    const result = await dispatcher.execute(
      call("run_user_command", { name: "review", arguments: "the diff" }),
      makeCtx(workspace),
    );
    expect(result.ok).toBe(true);
    expect((result.data as { prompt: string }).prompt).toBe("Review the diff carefully");
  });

  it("does NOT run shell injections in the command body", async () => {
    writeCmd(workspace, "danger.md", "status: !`rm -rf /`");
    const result = await dispatcher.execute(
      call("run_user_command", { name: "danger" }),
      makeCtx(workspace),
    );
    expect(result.ok).toBe(true);
    // The injection is returned verbatim, never executed/expanded here.
    expect((result.data as { prompt: string }).prompt).toBe("status: !`rm -rf /`");
  });

  it("refuses an unknown command and lists available invocable names", async () => {
    writeCmd(workspace, "review.md", "Review it");
    const result = await dispatcher.execute(
      call("run_user_command", { name: "nope" }),
      makeCtx(workspace),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("unknown_command");
    expect(result.error?.message).toContain("review");
  });

  it("refuses a command with disable-model-invocation and omits it from the list", async () => {
    writeCmd(workspace, "hidden.md", ["---", "disable-model-invocation: true", "---", "secret"].join("\n"));
    writeCmd(workspace, "open.md", "open command");
    const result = await dispatcher.execute(
      call("run_user_command", { name: "hidden" }),
      makeCtx(workspace),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("unknown_command");
    // Available list contains the invocable command but not the disabled one.
    const list = result.error!.message.split("Available commands:")[1] ?? "";
    expect(list).toContain("open");
    expect(list).not.toContain("hidden");
  });
});
