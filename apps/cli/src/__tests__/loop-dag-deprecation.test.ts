// Phase 1 of retiring the Loop DAG engine: an announcement, not a removal.
//
// What these tests pin down is exactly the part that is easy to break later:
// the notice must reach stderr, must never touch the machine-readable stdout of
// `loop-dag` / `loop-dag-resources`, must not move the exit code, and must not
// make any existing command or checkpoint unreachable.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loopDagCommand,
  loopDagExportGraphCommand,
  loopDagResourcesCommand,
  warnLoopDagDeprecated,
} from "../commands/loop.js";
import { getLocale, setLocale } from "../i18n.js";
import { registerLoopCommands } from "../register-loop.js";

const registration = {
  collect: (value: string, previous: string[]) => [...previous, value],
  parsePositiveInt: Number,
  parseNonNegativeInt: Number,
  parsePositiveFloat: Number,
  rootProfile: () => undefined,
};

describe("Loop DAG deprecation notice", () => {
  const cwd = process.cwd();
  const locale = getLocale();
  const workspaces: string[] = [];

  afterEach(() => {
    process.chdir(cwd);
    setLocale(locale);
    process.exitCode = undefined;
    vi.restoreAllMocks();
    for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  });

  function tempWorkspace(): string {
    const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), "seekforge-dag-deprecation-")));
    workspaces.push(workspace);
    process.chdir(workspace);
    return workspace;
  }

  /**
   * An unfinished DAG left on disk by an older release: schemaVersion 1, one
   * node already passed, no completedAt. Nothing about the deprecation window
   * may make this file unreadable.
   */
  function writeInFlightCheckpoint(workspace: string, dagId: string): void {
    mkdirSync(join(workspace, ".seekforge", "loop-dags"), { recursive: true });
    writeFileSync(
      join(workspace, ".seekforge", "loop-dags", `${dagId}.json`),
      JSON.stringify({
        schemaVersion: 1,
        dagId,
        fingerprint: "a".repeat(64),
        spentCost: 0.25,
        spentTokens: 1200,
        results: [
          {
            id: "build",
            status: "passed",
            output: { status: "passed", sessionId: "sess-1", costUsd: 0.25, tokensUsed: 1200, iterations: 2 },
          },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:10:00.000Z",
      }),
    );
  }

  function captureStreams() {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    return {
      stderr: () => stderr.mock.calls.map((call) => String(call[0])).join(""),
      stdout: () => stdout.mock.calls.map((call) => String(call[0])).join(""),
      logged: () => log.mock.calls.map((call) => call.map(String).join(" ")).join("\n"),
    };
  }

  it("names the cost, the window, and both halves of the migration path", () => {
    setLocale("en");
    const streams = captureStreams();

    warnLoopDagDeprecated();

    const notice = streams.stderr();
    expect(notice).toMatch(/deprecat/i);
    expect(notice).toMatch(/no new capabilities/i);
    expect(notice).toContain(".seekforge/loop-dags/");
    expect(notice).toMatch(/resumable/i);
    expect(notice).toMatch(/next major release removes the engine/i);
    expect(notice).toContain("seekforge loop-dag export-graph <file> -o graph.json");
    expect(notice).toContain("seekforge graph run graph.json");
    // No date is promised — the window has no announced cut-off yet.
    expect(notice).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    expect(streams.stdout()).toBe("");
    expect(streams.logged()).toBe("");
    expect(process.exitCode).toBeUndefined();
  });

  it("is translated, and keeps the commands machine-readable in either locale", () => {
    setLocale("zh-CN");
    const streams = captureStreams();

    warnLoopDagDeprecated();

    const notice = streams.stderr();
    expect(notice).toContain("弃用");
    expect(notice).toContain(".seekforge/loop-dags/");
    expect(notice).toContain("恢复");
    expect(notice).toContain("seekforge loop-dag export-graph <file> -o graph.json");
    expect(notice).toContain("seekforge graph run graph.json");
    expect(streams.stdout()).toBe("");
  });

  it("still reads an in-flight checkpoint and keeps stdout a single JSON document", async () => {
    const workspace = tempWorkspace();
    writeInFlightCheckpoint(workspace, "in-flight");
    setLocale("en");
    const streams = captureStreams();

    await loopDagResourcesCommand("in-flight", "inspect");

    expect(streams.stderr()).toMatch(/deprecat/i);
    // The report is the whole of stdout: nothing from the notice leaked in.
    const report = JSON.parse(streams.logged()) as { dagId: string; completed: boolean; worktrees: unknown[] };
    expect(report).toMatchObject({ dagId: "in-flight", completed: false, worktrees: [] });
    expect(streams.stdout()).toBe("");
    // The inspect succeeded before the notice existed; it still does.
    expect(process.exitCode).toBeUndefined();
  });

  it("does not move the exit code loop-dag would have produced", async () => {
    tempWorkspace();
    setLocale("en");
    const streams = captureStreams();

    await loopDagCommand("missing.json", {});

    expect(streams.stderr()).toMatch(/deprecat/i);
    expect(streams.stderr()).toMatch(/Loop DAG file not found/);
    expect(streams.logged()).toBe("");
    expect(process.exitCode).toBe(1);
  });

  it("stays quiet on export-graph, which is the way out", () => {
    const workspace = tempWorkspace();
    setLocale("en");
    writeFileSync(
      join(workspace, "dag.json"),
      JSON.stringify({ nodes: [{ id: "build", task: "do the work", verifyCommand: "pnpm test" }] }),
    );
    const streams = captureStreams();

    loopDagExportGraphCommand("dag.json", { graphId: "exported" });

    expect(streams.stderr()).not.toMatch(/deprecat/i);
    expect((JSON.parse(streams.stdout()) as { graphId: string }).graphId).toBe("exported");
    expect(process.exitCode).toBeUndefined();
  });

  it("removes nothing: in-flight DAGs keep every command and resume flag", () => {
    const program = new Command();
    registerLoopCommands(program, registration);

    const loopDag = program.commands.find((command) => command.name() === "loop-dag");
    expect(loopDag).toBeDefined();
    for (const flag of ["--resume", "--rerun", "--approve", "--dag-id"]) {
      expect(loopDag?.options.some((option) => option.long === flag)).toBe(true);
    }
    expect(loopDag?.commands.some((command) => command.name() === "export-graph")).toBe(true);
    expect(program.commands.some((command) => command.name() === "loop-dag-resources")).toBe(true);
  });
});
