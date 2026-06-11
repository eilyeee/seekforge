/** Test helpers: fake (scripted) agents and throwaway fixtures. No network. */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentEvent, TokenUsage } from "@seekforge/shared";
import type { RunAgentTaskInput } from "@seekforge/core";
import type { CreateAgentFn } from "../src/task-runner.js";
import type { Check, TaskDef } from "../src/tasks.js";

export const FAKE_USAGE: TokenUsage = {
  promptTokens: 100,
  completionTokens: 50,
  cacheHitTokens: 0,
  costUsd: 0.0123,
};

/** Standard happy-path event script ending in session.completed. */
export function completedEvents(summary = "done"): AgentEvent[] {
  return [
    { type: "session.created", sessionId: "fake-session" },
    {
      type: "session.completed",
      report: { summary, changedFiles: [], commandsRun: [], verification: "", usage: FAKE_USAGE },
    },
  ];
}

/**
 * A CreateAgentFn whose agent runs `script` (which may write files into
 * input.projectPath) and yields the returned events.
 */
export function fakeAgent(
  script: (input: RunAgentTaskInput) => AgentEvent[] | Promise<AgentEvent[]>,
): CreateAgentFn {
  return () => ({
    agent: {
      async *runTask(input: RunAgentTaskInput): AsyncIterable<AgentEvent> {
        for (const event of await script(input)) yield event;
      },
    },
  });
}

export type TempFixture = {
  /** Pass as opts.fixturesDir. */
  fixturesDir: string;
  /** The fixture directory itself (fixturesDir/<name>). */
  dir: string;
  name: string;
  cleanup: () => void;
};

/** Creates fixturesDir/<name>/ with the given files (relative path → content). */
export function makeTempFixture(files: Record<string, string>, name = "fx"): TempFixture {
  const fixturesDir = mkdtempSync(join(tmpdir(), "seekforge-eval-fixtures-"));
  const dir = join(fixturesDir, name);
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return { fixturesDir, dir, name, cleanup: () => rmSync(fixturesDir, { recursive: true, force: true }) };
}

export function makeTask(overrides: Partial<TaskDef> & { checks?: Check[] } = {}): TaskDef {
  return {
    id: "test-task",
    title: "Test task",
    fixture: "fx",
    mode: "edit",
    task: "do the thing",
    checks: [{ type: "answer_matches", pattern: "." }],
    ...overrides,
  };
}
