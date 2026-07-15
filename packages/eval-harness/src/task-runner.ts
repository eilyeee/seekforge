/**
 * runTask: copies a fixture to a throwaway git workspace, runs the agent on
 * it, then evaluates every check deterministically (no LLM judges).
 */

import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { scoreSession, type AgentCore } from "@seekforge/core";
import { fixturesDir as defaultFixturesDir } from "./paths.js";
import type { Check, TaskDef } from "./tasks.js";

const execFileAsync = promisify(execFile);

const COMMAND_TIMEOUT_MS = 120_000;

export type CreatedAgent = { agent: AgentCore; dispose?: () => void };
export type CreateAgentFn = () => CreatedAgent | Promise<CreatedAgent>;

export type RunTaskOptions = {
  createAgent: CreateAgentFn;
  /** Keep the temp workspace for debugging (reported as workspaceDir). */
  keepDir?: boolean;
  /** Override the fixture root (tests use throwaway fixtures). */
  fixturesDir?: string;
  /** Appended to the task text (A/B prompt-style variants); see variants.ts. */
  taskSuffix?: string;
};

/** One skill the core selected for this task's session (from skills-usage.jsonl). */
export type SkillUsage = {
  skillId: string;
  scope: string;
  score: number;
};

export type CheckResult = {
  check: Check;
  passed: boolean;
  detail?: string;
};

export type TaskMetrics = {
  /** Assistant turns, from core's scoreSession (absent if scoring failed). */
  turns?: number;
  toolCalls: number;
  failedToolCalls: number;
  costUsd: number;
  /** Token fields are absent in reports produced before continuous eval v2. */
  promptTokens?: number;
  completionTokens?: number;
  cacheHitTokens?: number;
  totalTokens?: number;
  durationMs: number;
  /** Heuristic 0-100 session score from core (absent if scoring failed). */
  score?: number;
};

export type TaskResult = {
  taskId: string;
  /** One-based sample index when a task is repeated. Omitted for legacy/single runs. */
  sample?: number;
  /** All checks passed AND the session completed. */
  success: boolean;
  checks: CheckResult[];
  metrics: TaskMetrics;
  /** Skills the core selected for this session (empty when none fired). */
  skills: SkillUsage[];
  /** Set when keepDir was requested. */
  workspaceDir?: string;
  /** Set when the session emitted session.failed. */
  error?: string;
};

/** Reads .seekforge/skills-usage.jsonl from the (throwaway) workspace. */
async function readSkillUsage(dir: string): Promise<SkillUsage[]> {
  let raw: string;
  try {
    raw = await readFile(join(dir, ".seekforge", "skills-usage.jsonl"), "utf8");
  } catch {
    return []; // no skills fired (file absent)
  }
  const usage: SkillUsage[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as { skillId?: unknown; scope?: unknown; score?: unknown };
      if (typeof entry.skillId === "string") {
        usage.push({
          skillId: entry.skillId,
          scope: typeof entry.scope === "string" ? entry.scope : "unknown",
          score: typeof entry.score === "number" ? entry.score : 0,
        });
      }
    } catch {
      // Skip malformed lines; one bad entry must not sink the run.
    }
  }
  return usage;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function tail(text: string, maxChars = 400): string {
  const trimmed = text.trim();
  return trimmed.length > maxChars ? `…${trimmed.slice(-maxChars)}` : trimmed;
}

/** Evaluates a single check against the workspace copy / final answer. */
export async function evaluateCheck(
  check: Check,
  ctx: { dir: string; answer: string },
): Promise<CheckResult> {
  switch (check.type) {
    case "file_contains":
    case "file_not_contains": {
      let content: string;
      try {
        content = await readFile(join(ctx.dir, check.path), "utf8");
      } catch {
        return { check, passed: false, detail: `file not found: ${check.path}` };
      }
      const matched = new RegExp(check.pattern).test(content);
      if (check.type === "file_contains") {
        return matched
          ? { check, passed: true }
          : { check, passed: false, detail: `pattern not found in ${check.path}: /${check.pattern}/` };
      }
      return matched
        ? { check, passed: false, detail: `forbidden pattern found in ${check.path}: /${check.pattern}/` }
        : { check, passed: true };
    }
    case "command_succeeds": {
      const cwd = check.cwd ? join(ctx.dir, check.cwd) : ctx.dir;
      try {
        await execFileAsync("/bin/sh", ["-c", check.command], { cwd, timeout: COMMAND_TIMEOUT_MS });
        return { check, passed: true };
      } catch (err) {
        const e = err as { code?: number | string; stderr?: string; stdout?: string; message?: string };
        const output = tail(`${e.stdout ?? ""}\n${e.stderr ?? ""}`);
        return {
          check,
          passed: false,
          detail: `command failed (${e.code ?? "error"}): ${check.command}${output ? `\n${output}` : ""}`,
        };
      }
    }
    case "answer_matches":
      return new RegExp(check.pattern).test(ctx.answer)
        ? { check, passed: true }
        : { check, passed: false, detail: `final answer does not match /${check.pattern}/` };
  }
}

export async function runTask(task: TaskDef, opts: RunTaskOptions): Promise<TaskResult> {
  const fixtureSrc = join(opts.fixturesDir ?? defaultFixturesDir, task.fixture);
  const dir = await mkdtemp(join(tmpdir(), `seekforge-eval-${task.id}-`));
  try {
    await cp(fixtureSrc, dir, { recursive: true });
    // A real repo so the agent's git tools (status/diff/commit) work.
    await git(dir, ["init", "-q"]);
    await git(dir, ["add", "-A"]);
    await git(dir, [
      "-c", "user.email=eval@seekforge.local",
      "-c", "user.name=seekforge-eval",
      "-c", "commit.gpgsign=false",
      "commit", "-q", "-m", "fixture baseline",
    ]);

    let created: CreatedAgent | undefined;
    let sessionId: string | undefined;
    let completed = false;
    let summary = "";
    let costUsd = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let cacheHitTokens = 0;
    let toolCalls = 0;
    let failedToolCalls = 0;
    let error: string | undefined;

    const startedAt = Date.now();
    try {
      created = await opts.createAgent();
      const events = created.agent.runTask({
        projectPath: dir,
        task: opts.taskSuffix ? `${task.task}${opts.taskSuffix}` : task.task,
        mode: task.mode,
        approvalMode: "auto",
      });
      for await (const event of events) {
        switch (event.type) {
          case "session.created":
            sessionId = event.sessionId;
            break;
          case "tool.started":
            toolCalls++;
            break;
          case "tool.completed":
            if (!event.result.ok) failedToolCalls++;
            break;
          case "usage.updated":
            ({ costUsd, promptTokens, completionTokens, cacheHitTokens } = event.usage);
            break;
          case "session.completed":
            completed = true;
            summary = event.report.summary;
            ({ costUsd, promptTokens, completionTokens, cacheHitTokens } = event.report.usage);
            break;
          case "session.failed":
            error = `${event.error.code}: ${event.error.message}`;
            break;
          default:
            break;
        }
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      created?.dispose?.();
    }
    if (!completed && error === undefined) error = "session ended without session.completed";
    const durationMs = Date.now() - startedAt;

    let turns: number | undefined;
    let score: number | undefined;
    if (sessionId !== undefined) {
      try {
        const sessionScore = scoreSession(dir, sessionId);
        score = sessionScore.score;
        turns = sessionScore.metrics.turns;
      } catch {
        // Trace files missing (e.g. a fake agent): leave score/turns unset.
      }
    }

    const checks: CheckResult[] = [];
    for (const check of task.checks) {
      checks.push(await evaluateCheck(check, { dir, answer: summary }));
    }

    // Capture skill usage from the workspace BEFORE the finally block wipes it.
    const skills = await readSkillUsage(dir);

    const result: TaskResult = {
      taskId: task.id,
      success: completed && error === undefined && checks.every((c) => c.passed),
      checks,
      metrics: {
        turns,
        toolCalls,
        failedToolCalls,
        costUsd,
        promptTokens,
        completionTokens,
        cacheHitTokens,
        totalTokens: promptTokens + completionTokens,
        durationMs,
        score,
      },
      skills,
    };
    if (opts.keepDir) result.workspaceDir = dir;
    if (error !== undefined) result.error = error;
    return result;
  } finally {
    if (!opts.keepDir) await rm(dir, { recursive: true, force: true });
  }
}
