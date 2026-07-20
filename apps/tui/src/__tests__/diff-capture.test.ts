import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@seekforge/shared";
import { createDiffCapture } from "../diff-capture.js";

const started = (toolName: string, args: unknown): AgentEvent => ({
  type: "tool.started",
  toolName,
  args,
});

const completed = (toolName: string, ok: boolean): AgentEvent => ({
  type: "tool.completed",
  toolName,
  result: ok ? { ok: true, data: {} } : { ok: false, error: { code: "boom", message: "failed" } },
});

describe("createDiffCapture", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-diffcap-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("captures a write_file creation with null before", () => {
    const capture = createDiffCapture(dir);
    expect(capture.onEvent(started("write_file", { path: "new.txt", content: "hello\n" }))).toBeNull();
    fs.writeFileSync(path.join(dir, "new.txt"), "hello\n");
    const diff = capture.onEvent(completed("write_file", true));
    expect(diff).toEqual({
      path: "new.txt",
      lines: [
        { kind: "hunk", text: "@@ -0,0 +1,1 @@" },
        { kind: "add", text: "+hello" },
      ],
    });
  });

  it("captures a write_file creation below newly created nested directories", () => {
    const capture = createDiffCapture(dir);
    expect(capture.onEvent(started("write_file", { path: "new/deep/file.txt", content: "hello\n" }))).toBeNull();
    fs.mkdirSync(path.join(dir, "new", "deep"), { recursive: true });
    fs.writeFileSync(path.join(dir, "new", "deep", "file.txt"), "hello\n");

    expect(capture.onEvent(completed("write_file", true))).toEqual({
      path: "new/deep/file.txt",
      lines: [
        { kind: "hunk", text: "@@ -0,0 +1,1 @@" },
        { kind: "add", text: "+hello" },
      ],
    });
  });

  it("captures an apply_patch modification", () => {
    fs.writeFileSync(path.join(dir, "mod.txt"), "a\nb\nc\n");
    const capture = createDiffCapture(dir);
    capture.onEvent(started("apply_patch", { path: "mod.txt", edits: [] }));
    fs.writeFileSync(path.join(dir, "mod.txt"), "a\nX\nc\n");
    const diff = capture.onEvent(completed("apply_patch", true));
    expect(diff?.path).toBe("mod.txt");
    expect(diff?.lines).toContainEqual({ kind: "del", text: "-b" });
    expect(diff?.lines).toContainEqual({ kind: "add", text: "+X" });
  });

  it("returns null on failed completion and pops the pending entry", () => {
    fs.writeFileSync(path.join(dir, "f.txt"), "a\n");
    const capture = createDiffCapture(dir);
    capture.onEvent(started("write_file", { path: "f.txt" }));
    fs.writeFileSync(path.join(dir, "f.txt"), "b\n");
    expect(capture.onEvent(completed("write_file", false))).toBeNull();
    // Stack is empty now: a stray completion has nothing to pair with.
    expect(capture.onEvent(completed("write_file", true))).toBeNull();
  });

  it("pairs overlapping same-name calls LIFO", () => {
    const capture = createDiffCapture(dir);
    capture.onEvent(started("write_file", { path: "first.txt" }));
    capture.onEvent(started("write_file", { path: "second.txt" }));
    fs.writeFileSync(path.join(dir, "first.txt"), "one\n");
    fs.writeFileSync(path.join(dir, "second.txt"), "two\n");
    const d1 = capture.onEvent(completed("write_file", true));
    const d2 = capture.onEvent(completed("write_file", true));
    expect(d1?.path).toBe("second.txt");
    expect(d2?.path).toBe("first.txt");
  });

  it("refuses paths escaping the workspace", () => {
    const outside = path.join(dir, "..", `escape-${path.basename(dir)}.txt`);
    const capture = createDiffCapture(dir);
    capture.onEvent(started("write_file", { path: `../${path.basename(outside)}` }));
    fs.writeFileSync(outside, "evil\n");
    try {
      expect(capture.onEvent(completed("write_file", true))).toBeNull();
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("refuses a symlinked file that resolves outside the workspace", () => {
    const outside = path.join(dir, "..", `outside-${path.basename(dir)}.txt`);
    fs.writeFileSync(outside, "secret\n");
    fs.symlinkSync(outside, path.join(dir, "linked.txt"));
    try {
      const capture = createDiffCapture(dir);
      capture.onEvent(started("write_file", { path: "linked.txt" }));
      fs.writeFileSync(outside, "changed\n");
      expect(capture.onEvent(completed("write_file", true))).toBeNull();
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("returns null for an empty diff (no actual change)", () => {
    fs.writeFileSync(path.join(dir, "same.txt"), "a\n");
    const capture = createDiffCapture(dir);
    capture.onEvent(started("apply_patch", { path: "same.txt" }));
    expect(capture.onEvent(completed("apply_patch", true))).toBeNull();
  });

  it("ignores non-write tools and bad args without throwing", () => {
    const capture = createDiffCapture(dir);
    expect(capture.onEvent(started("run_command", { command: "ls" }))).toBeNull();
    expect(capture.onEvent(started("write_file", { path: 42 }))).toBeNull();
    expect(capture.onEvent(completed("write_file", true))).toBeNull();
  });
});
