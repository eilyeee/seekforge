import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureShellBaseline, collectShellChanges } from "../../src/tools/shell-checkpoint.js";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { setShellRunnerForTests } from "../../src/tools/builtins/command.js";
import { call, makeCtx } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  setShellRunnerForTests(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seekforge-shellcp-"));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}

function write(root: string, rel: string, content: string | Buffer): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

/** A repository with one commit: clean.txt, dirty.txt, gone.txt, and an ignore rule. */
function repo(): string {
  const dir = tempDir();
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "commit.gpgsign", "false");
  write(dir, "clean.txt", "clean\n");
  write(dir, "dirty.txt", "committed\n");
  write(dir, "gone.txt", "bye\n");
  write(dir, ".gitignore", "ignored.log\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("shell checkpoints", () => {
  it("finds every kind of change and the content each file had before", async () => {
    const ws = repo();
    write(ws, "dirty.txt", "dirty before\n");
    write(ws, "note.txt", "untracked before\n");
    write(ws, "same.txt", "untouched\n");

    const baseline = await captureShellBaseline(ws);
    expect(baseline.kind).toBe("ready");

    // What a command might do.
    write(ws, "clean.txt", "changed\n");
    write(ws, "dirty.txt", "changed again\n");
    unlinkSync(join(ws, "gone.txt"));
    write(ws, "new/created.txt", "fresh\n");
    write(ws, "note.txt", "untracked after\n");
    write(ws, "same.txt", "untouched\n"); // rewritten with identical content
    write(ws, "ignored.log", "build output\n");
    write(ws, ".env", "API_KEY=secret\n");
    write(ws, ".seekforge/sessions/s1/events.jsonl", "{}\n");

    const changes = await collectShellChanges(ws, baseline);
    expect(changes.entries).toEqual([
      { path: "clean.txt", before: "clean\n" },
      { path: "dirty.txt", before: "dirty before\n" },
      { path: "gone.txt", before: "bye\n" },
      { path: "new/created.txt", before: null },
      { path: "note.txt", before: "untracked before\n" },
    ]);
    expect(changes.note).toEqual({
      status: "recorded",
      files: ["clean.txt", "dirty.txt", "gone.txt", "new/created.txt", "note.txt"],
    });
  });

  it("records nothing outside a git work tree, and says why", async () => {
    const ws = tempDir();
    const baseline = await captureShellBaseline(ws);
    expect(baseline).toEqual({ kind: "skipped", reason: "not a git work tree" });
    expect(await collectShellChanges(ws, baseline)).toEqual({
      entries: [],
      note: { status: "skipped", reason: "not a git work tree" },
    });
  });

  it("records nothing when the uncommitted state is over the bounds", async () => {
    const ws = repo();
    for (let i = 0; i < 3; i++) write(ws, `u${i}.txt`, "x");
    expect(await captureShellBaseline(ws, { limits: { maxFiles: 2 } })).toEqual({
      kind: "skipped",
      reason: "3 uncommitted files exceed the 2-file checkpoint limit",
    });
    expect(await captureShellBaseline(ws, { limits: { maxTotalBytes: 2 } })).toEqual({
      kind: "skipped",
      reason: "uncommitted files exceed the checkpoint size limit",
    });

    const baseline = await captureShellBaseline(ws, { limits: { maxFiles: 3 } });
    for (let i = 0; i < 4; i++) write(ws, `made${i}.txt`, "y");
    const changes = await collectShellChanges(ws, baseline, { limits: { maxFiles: 3 } });
    expect(changes.entries).toEqual([]);
    expect(changes.note).toEqual({
      status: "skipped",
      reason: "the command changed more than 3 files, over the checkpoint limit",
    });
  });

  it("reports changed files it cannot snapshot as a partial checkpoint", async () => {
    const ws = repo();
    write(ws, "image.bin", Buffer.from([0, 1, 2]));
    git(ws, "add", "image.bin");
    git(ws, "commit", "-q", "-m", "binary");
    write(ws, "big.txt", "b".repeat(64));

    const limits = { maxFileBytes: 16 };
    const baseline = await captureShellBaseline(ws, { limits });
    write(ws, "image.bin", Buffer.from([0, 9, 9]));
    write(ws, "big.txt", "c".repeat(65));
    write(ws, "clean.txt", "edited\n");

    const changes = await collectShellChanges(ws, baseline, { limits });
    expect(changes.entries).toEqual([{ path: "clean.txt", before: "clean\n" }]);
    expect(changes.note).toEqual({
      status: "partial",
      files: ["clean.txt"],
      unrestorable: [
        { path: "big.txt", reason: "larger than the snapshot limit" },
        { path: "image.bin", reason: "binary file" },
      ],
    });
  });

  it("notes a command that moved HEAD", async () => {
    const ws = repo();
    const baseline = await captureShellBaseline(ws);
    const before = git(ws, "rev-parse", "HEAD").trim();
    write(ws, "clean.txt", "committed by the command\n");
    git(ws, "commit", "-q", "-am", "by the command");
    const after = git(ws, "rev-parse", "HEAD").trim();

    const changes = await collectShellChanges(ws, baseline);
    // The file is clean again, so git no longer lists it: only the move is known.
    expect(changes.entries).toEqual([]);
    expect(changes.note).toEqual({ status: "recorded", files: [], headMoved: { from: before, to: after } });
  });

  it("works from a subdirectory workspace and ignores the rest of the repository", async () => {
    const root = repo();
    write(root, "pkg/lib.txt", "lib\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "pkg");
    const ws = join(root, "pkg");

    const baseline = await captureShellBaseline(ws);
    write(root, "clean.txt", "outside the workspace\n");
    write(root, "pkg/lib.txt", "changed\n");
    write(root, "pkg/added.txt", "new\n");

    const changes = await collectShellChanges(ws, baseline);
    expect(changes.entries).toEqual([
      { path: "added.txt", before: null },
      { path: "lib.txt", before: "lib\n" },
    ]);
  });

  it("handles a repository without commits", async () => {
    const ws = tempDir();
    git(ws, "init", "-q");
    write(ws, "staged.txt", "staged\n");
    git(ws, "add", "staged.txt");

    const baseline = await captureShellBaseline(ws);
    write(ws, "staged.txt", "rewritten\n");
    write(ws, "made.txt", "made\n");
    const changes = await collectShellChanges(ws, baseline);
    expect(changes.entries).toEqual([
      { path: "made.txt", before: null },
      { path: "staged.txt", before: "staged\n" },
    ]);
  });
});

describe("run_command shell checkpoints", () => {
  const dispatcher = createDefaultDispatcher();

  it("checkpoints what an executed command changed, even when it fails", async () => {
    const ws = repo();
    const recorded: Array<{ path: string; before: string | null; origin: unknown }> = [];
    const notes: unknown[] = [];
    setShellRunnerForTests(async () => {
      write(ws, "clean.txt", "changed by the command\n");
      return { exitCode: 1, stdout: "", stderr: "boom", durationMs: 1 };
    });
    const ctx = makeCtx(ws, {
      checkpoint: (path, before, origin) => recorded.push({ path, before, origin }),
      recordShellCheckpoint: (note) => notes.push(note),
    });

    const result = await dispatcher.execute(call("run_command", { command: "make generate" }), ctx);
    expect(result.ok).toBe(true);
    expect(recorded).toEqual([
      { path: "clean.txt", before: "clean\n", origin: { source: "shell", command: "make generate" } },
    ]);
    expect(notes).toEqual([{ command: "make generate", status: "recorded", files: ["clean.txt"] }]);
  });

  it("still returns the command result when recording a checkpoint fails", async () => {
    const ws = repo();
    const notes: unknown[] = [];
    setShellRunnerForTests(async () => {
      write(ws, "clean.txt", "changed\n");
      return { exitCode: 0, stdout: "built", stderr: "", durationMs: 1 };
    });
    const ctx = makeCtx(ws, {
      checkpoint: () => {
        throw new Error("disk full");
      },
      recordShellCheckpoint: (note) => notes.push(note),
    });
    const result = await dispatcher.execute(call("run_command", { command: "make" }), ctx);
    expect(result).toMatchObject({ ok: true, data: { exitCode: 0, stdout: "built" } });
    expect(notes).toEqual([{ command: "make", status: "skipped", reason: "could not record checkpoints: disk full" }]);
  });

  it("says a cancelled run was cancelled, not that the workspace is not a repository", async () => {
    const ws = repo();
    const controller = new AbortController();
    controller.abort();
    expect(await captureShellBaseline(ws, { signal: controller.signal })).toEqual({
      kind: "skipped",
      reason: "the run was cancelled before the checkpoint was taken",
    });
  });

  it("skips the git probes for read-only commands and without a checkpoint sink", async () => {
    const ws = repo();
    let ran = 0;
    setShellRunnerForTests(async () => {
      ran++;
      write(ws, "clean.txt", `run ${ran}\n`);
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    });
    const recorded: string[] = [];
    const notes: unknown[] = [];
    const withSink = makeCtx(ws, {
      checkpoint: (path) => recorded.push(path),
      recordShellCheckpoint: (note) => notes.push(note),
    });
    await dispatcher.execute(call("run_command", { command: "ls -la" }), withSink);
    await dispatcher.execute(call("run_command", { command: "git status" }), withSink);
    await dispatcher.execute(call("run_command", { command: "make" }), makeCtx(ws));
    expect(ran).toBe(3);
    expect(recorded).toEqual([]);
    expect(notes).toEqual([]);
  });
});
