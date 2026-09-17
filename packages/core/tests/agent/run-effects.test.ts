import { describe, expect, it } from "vitest";
import { backgroundExitMessages, changedPathsOf } from "../../src/agent/run-effects.js";

const paths = (entries: Array<{ path: string }>) => entries.map((entry) => entry.path);

describe("changedPathsOf", () => {
  it("reads the single file of the edit tools", () => {
    for (const tool of ["apply_patch", "write_file", "notebook_edit", "lsp_format"]) {
      expect(paths(changedPathsOf(tool, { ok: true, meta: { path: "a.ts" } }, []))).toEqual(["a.ts"]);
    }
    // A format that changed nothing changed nothing.
    expect(changedPathsOf("lsp_format", { ok: true, data: { formatted: false }, meta: { path: "a.ts" } }, [])).toEqual(
      [],
    );
    // A read names a path too, but did not change it.
    expect(changedPathsOf("read_file", { ok: true, meta: { path: "a.ts" } }, [])).toEqual([]);
  });

  it("reads every file of an LSP workspace edit", () => {
    const result = {
      ok: true,
      data: { files: [{ path: "a.ts", edits: 2 }, { path: "b.ts", edits: 1 }, { nope: 1 }, null] },
      meta: { path: "a.ts" },
    };
    expect(paths(changedPathsOf("lsp_rename", result, []))).toEqual(["a.ts", "b.ts"]);
    expect(paths(changedPathsOf("lsp_apply_code_action", result, []))).toEqual(["a.ts", "b.ts"]);
  });

  it("counts checkpointed paths only when the call succeeded, except shell ones", () => {
    const touched = [
      { path: "edited.ts", shell: false },
      { path: "built.js", shell: true },
    ];
    expect(changedPathsOf("mcp__x__write", { ok: true }, touched)).toEqual([
      { path: "edited.ts", viaShellOnly: false },
      { path: "built.js", viaShellOnly: true },
    ]);
    // A failed write may not have written; a failed command did change what git saw.
    expect(changedPathsOf("run_command", { ok: false }, touched)).toEqual([{ path: "built.js", viaShellOnly: true }]);
  });

  it("reports each path once and knows when a tool also named it", () => {
    const touched = [{ path: "a.ts", shell: true }];
    expect(changedPathsOf("write_file", { ok: true, meta: { path: "a.ts" } }, touched)).toEqual([
      { path: "a.ts", viaShellOnly: false },
    ]);
  });
});

describe("backgroundExitMessages", () => {
  it("points at task_output without quoting any output", () => {
    const { model, user } = backgroundExitMessages([
      { id: "bg-1", command: "pnpm dev", exitCode: 1, status: "failed", durationMs: 10 },
      { id: "bg-2", command: "sleep 100", exitCode: null, status: "cancelled", durationMs: 10 },
      {
        id: "bg-3",
        command: "nope",
        exitCode: null,
        status: "failed",
        durationMs: 1,
        error: { code: "spawn_failed", message: "ENOENT" },
      },
      { id: "bg-4", command: "server", exitCode: null, status: "failed", durationMs: 1 },
    ]);
    expect(model.startsWith("[harness] Background task update:")).toBe(true);
    expect(model).toContain(
      '- bg-1 exited with code 1: "pnpm dev" — read its output with task_output (taskId "bg-1").',
    );
    expect(model).toContain("bg-2 was killed");
    expect(model).toContain("bg-3 failed to start (ENOENT)");
    expect(model).toContain("bg-4 was terminated by a signal");
    expect(user).toEqual([
      "Background task bg-1 exited with code 1: pnpm dev",
      "Background task bg-2 was killed: sleep 100",
      "Background task bg-3 failed to start (ENOENT): nope",
      "Background task bg-4 was terminated by a signal: server",
    ]);
  });
});
