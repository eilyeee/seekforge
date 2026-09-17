// `seekforge rewind` restores files and says what it could not undo.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendCheckpoint, appendShellCheckpointNote, writeSessionMeta } from "@seekforge/core";
import { rewindCommand } from "../commands/rewind.js";

let cwd: string;
let out: string[];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "sf-rewind-"));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  out = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(cwd, { recursive: true, force: true });
});

it("prints the shell side effects a rewind leaves in place", () => {
  const id = "s-rewind";
  const now = new Date().toISOString();
  writeSessionMeta(cwd, { id, task: "t", mode: "edit", status: "completed", createdAt: now, updatedAt: now });
  writeFileSync(join(cwd, "a.txt"), "after");
  appendCheckpoint(cwd, id, { ts: now, path: "a.txt", before: "before", turn: 0 });
  appendShellCheckpointNote(cwd, id, {
    ts: now,
    turn: 0,
    command: "git commit -am wip",
    status: "recorded",
    headMoved: { from: "a", to: "b" },
  });
  appendShellCheckpointNote(cwd, id, {
    ts: now,
    turn: 0,
    command: "make",
    status: "skipped",
    reason: "not a git repository",
  });

  rewindCommand(id);
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("before");
  const text = out.join("\n");
  expect(text).toContain("warning: 1 shell command not checkpointed: not a git repository");
  expect(text).toContain("warning: 1 shell command moved git HEAD");
  expect(text).toContain("rewound session s-rewind: 1 restored");
});
