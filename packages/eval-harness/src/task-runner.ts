/**
 * Copies a fixture to a throwaway git workspace, runs the selected orchestration
 * mode, then evaluates deterministic checks (no LLM judges).
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { cp, mkdtemp, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  addMemoryFact,
  approveMemoryCandidate,
  memoryStats,
  readFactMeta,
  readSessionMeta,
  rejectMemoryCandidate,
  resumeAutoLoop,
  runAutoLoop,
  scoreSession,
  type AgentCore,
  type AgentCoreDeps,
  type LoopResult,
  type RunAgentTaskInput,
} from "@seekforge/core";
import type { TokenUsage } from "@seekforge/shared";
import { fixturesDir as defaultFixturesDir } from "./paths.js";
import type { Check, ExpectedSessionStatus, SessionScenarioStep, TaskDef, TaskRunner } from "./tasks.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const FORCE_KILL_DELAY_MS = 250;
const CHECK_FILE_LIMIT_BYTES = 5 * 1024 * 1024;
const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 };

export type CreatedAgent = {
  agent: AgentCore;
  /** Required by loop tasks because core's auto-loop constructs its own AgentCore. */
  deps?: AgentCoreDeps;
  dispose?: () => void;
};
export type CreateAgentFn = () => CreatedAgent | Promise<CreatedAgent>;

export type RunTaskOptions = {
  createAgent: CreateAgentFn;
  /** Keep the temp workspace for debugging (reported as workspaceDir). */
  keepDir?: boolean;
  /** Override the fixture root (tests use throwaway fixtures). */
  fixturesDir?: string;
  /** Appended to every agent prompt (A/B prompt-style variants). */
  taskSuffix?: string;
  /** Test seams; production always uses core's real orchestration functions. */
  runLoop?: typeof runAutoLoop;
  resumeLoop?: typeof resumeAutoLoop;
};

/** One skill the core selected for this task's session (from skills-usage.jsonl). */
export type SkillUsage = { skillId: string; scope: string; score: number };

export type CheckResult = { check: Check; passed: boolean; detail?: string };

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

export type ExecutionStep = {
  index: number;
  type: SessionScenarioStep["type"];
  status: string;
  expectedStatus?: string;
  passed: boolean;
  sessionId?: string;
};

export type TaskExecution = {
  runner: TaskRunner;
  status: string;
  expectedStatus: string;
  passed: boolean;
  sessionIds: string[];
  iterations?: number;
  maxIterations?: number;
  resumed?: boolean;
  steps?: ExecutionStep[];
};

export type TaskResult = {
  taskId: string;
  /** One-based sample index when a task is repeated. Omitted for legacy/single runs. */
  sample?: number;
  /** All checks passed AND orchestration reached its expected terminal state. */
  success: boolean;
  checks: CheckResult[];
  metrics: TaskMetrics;
  skills: SkillUsage[];
  execution?: TaskExecution;
  /** Set when keepDir was requested. */
  workspaceDir?: string;
  /** Set for unexpected orchestration/session failures. */
  error?: string;
};

type RunObservation = {
  status: "completed" | "failed" | "incomplete";
  summary: string;
  sessionId?: string;
  usage: TokenUsage;
  toolCalls: number;
  failedToolCalls: number;
  error?: string;
};

type MutableMetrics = {
  usage: TokenUsage;
  usageBySession: Map<string, TokenUsage>;
  unboundUsage: TokenUsage;
  toolCalls: number;
  failedToolCalls: number;
};

function addUsage(target: TokenUsage, usage: TokenUsage): TokenUsage {
  return {
    promptTokens: target.promptTokens + usage.promptTokens,
    completionTokens: target.completionTokens + usage.completionTokens,
    cacheHitTokens: target.cacheHitTokens + usage.cacheHitTokens,
    costUsd: target.costUsd + usage.costUsd,
  };
}

function finiteMetric(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function taskText(text: string, suffix: string | undefined): string {
  return suffix ? `${text}${suffix}` : text;
}

/** Reads .seekforge/skills-usage.jsonl from the throwaway workspace. */
async function readSkillUsage(dir: string): Promise<SkillUsage[]> {
  let raw: string;
  try {
    raw = await readFile(join(dir, ".seekforge", "skills-usage.jsonl"), "utf8");
  } catch {
    return [];
  }
  const usage: SkillUsage[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const value = entry as Record<string, unknown>;
      if (typeof value.skillId === "string") {
        usage.push({
          skillId: value.skillId,
          scope: typeof value.scope === "string" ? value.scope : "unknown",
          score: typeof value.score === "number" && Number.isFinite(value.score) ? value.score : 0,
        });
      }
    } catch {
      // Skip malformed lines; one bad observability row must not sink the run.
    }
  }
  return usage;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function processGroupAlive(child: ChildProcess): boolean {
  if (child.pid === undefined || process.platform === "win32") return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

type CheckCommandError = Error & { code?: number | string; stdout?: string; stderr?: string };

/** Runs one deterministic check with bounded output and ownership of its process tree. */
export function runCheckCommand(
  command: string,
  cwd: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const output = (): { stdout: string; stderr: string } => ({
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    });
    const finish = (error?: CheckCommandError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      const captured = output();
      if (error) {
        error.stdout = captured.stdout;
        error.stderr = captured.stderr;
        reject(error);
      } else {
        resolve(captured);
      }
    };
    const terminate = (error: CheckCommandError): void => {
      try {
        killProcessGroup(child, "SIGTERM");
      } catch {
        // Preserve the check failure that initiated teardown.
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      forceKillTimer = setTimeout(() => {
        try {
          killProcessGroup(child, "SIGKILL");
        } catch {
          // Best-effort escalation after the check has already settled.
        }
      }, FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
      finish(error);
    };
    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > COMMAND_OUTPUT_LIMIT_BYTES) {
        terminate(new Error(`command output exceeded ${COMMAND_OUTPUT_LIMIT_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    };

    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      const groupAlive = processGroupAlive(child);
      if (forceKillTimer !== undefined && !groupAlive) clearTimeout(forceKillTimer);
      if (settled) return;
      if (groupAlive) {
        try {
          killProcessGroup(child, "SIGTERM");
        } catch {
          // The command result remains authoritative; cleanup is best effort.
        }
        forceKillTimer = setTimeout(() => {
          try {
            killProcessGroup(child, "SIGKILL");
          } catch {
            // Best-effort cleanup for descendants that outlived the shell.
          }
        }, FORCE_KILL_DELAY_MS);
        forceKillTimer.unref();
      }
      if (code === 0) {
        finish();
        return;
      }
      const error = new Error(
        `command failed (${signal ? `signal ${signal}` : `exit ${String(code)}`})`,
      ) as CheckCommandError;
      error.code = code ?? signal ?? "error";
      finish(error);
    });
    const timeoutTimer = setTimeout(() => {
      terminate(new Error(`command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

function tail(text: string, maxChars = 400): string {
  const trimmed = text.trim();
  return trimmed.length > maxChars ? `...${trimmed.slice(-maxChars)}` : trimmed;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function resolvePhysicalCheckPath(root: string, relPath: string): Promise<{ root: string; path: string }> {
  const physicalRoot = await realpath(root);
  const requested = resolve(physicalRoot, relPath);
  if (!isInside(requested, physicalRoot)) throw new Error(`path escapes eval workspace: ${relPath}`);
  const physical = await realpath(requested);
  if (physical !== requested || !isInside(physical, physicalRoot)) {
    throw new Error(`path uses a symlink or escapes eval workspace: ${relPath}`);
  }
  return { root: physicalRoot, path: requested };
}

async function readCheckFile(root: string, relPath: string): Promise<string> {
  const resolved = await resolvePhysicalCheckPath(root, relPath);
  const parent = dirname(resolved.path);
  const parentBefore = await stat(parent);
  const handle = await open(resolved.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    const [parentAfter, current, physicalAfter] = await Promise.all([
      stat(parent),
      stat(resolved.path),
      realpath(resolved.path),
    ]);
    if (
      !opened.isFile() ||
      physicalAfter !== resolved.path ||
      !sameIdentity(parentBefore, parentAfter) ||
      !sameIdentity(opened, current)
    ) {
      throw new Error(`file changed while opening: ${relPath}`);
    }
    if (opened.size > CHECK_FILE_LIMIT_BYTES) {
      throw new Error(`file exceeds ${CHECK_FILE_LIMIT_BYTES} bytes: ${relPath}`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, CHECK_FILE_LIMIT_BYTES - total + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > CHECK_FILE_LIMIT_BYTES) {
        throw new Error(`file grew beyond ${CHECK_FILE_LIMIT_BYTES} bytes: ${relPath}`);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function resolveCheckCwd(root: string, relPath: string | undefined): Promise<string> {
  const resolved = await resolvePhysicalCheckPath(root, relPath ?? ".");
  if (!(await stat(resolved.path)).isDirectory()) throw new Error(`check cwd is not a directory: ${relPath ?? "."}`);
  return resolved.path;
}

/** Evaluates a single check against the workspace copy / final answer. */
export async function evaluateCheck(check: Check, ctx: { dir: string; answer: string }): Promise<CheckResult> {
  switch (check.type) {
    case "file_contains":
    case "file_not_contains": {
      let content: string;
      try {
        content = await readCheckFile(ctx.dir, check.path);
      } catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        return {
          check,
          passed: false,
          detail: `${missing ? "file not found" : "file unavailable or unsafe"}: ${check.path}`,
        };
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
      try {
        const cwd = await resolveCheckCwd(ctx.dir, check.cwd);
        await runCheckCommand(check.command, cwd);
        return { check, passed: true };
      } catch (err) {
        const e = err as { code?: number | string; stderr?: string; stdout?: string };
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
    case "memory_stats": {
      const actual = memoryStats(ctx.dir)[check.field];
      const tolerance = check.tolerance ?? 0;
      const passed =
        actual === null || check.equals === null
          ? actual === check.equals
          : Math.abs(actual - check.equals) <= tolerance;
      return passed
        ? { check, passed: true }
        : { check, passed: false, detail: `memoryStats.${check.field}: expected ${check.equals}, got ${actual}` };
    }
    case "memory_fact_activity": {
      const actual = readFactMeta(ctx.dir)[check.fact]?.[check.activity] ?? 0;
      return actual === check.equals
        ? { check, passed: true }
        : {
            check,
            passed: false,
            detail: `memory fact ${JSON.stringify(check.fact)}: expected ${check.equals} ${check.activity}, got ${actual}`,
          };
    }
  }
}

async function observeAgent(agent: AgentCore, input: RunAgentTaskInput): Promise<RunObservation> {
  let status: RunObservation["status"] = "incomplete";
  let summary = "";
  let sessionId: string | undefined;
  let usage = ZERO_USAGE;
  let toolCalls = 0;
  let failedToolCalls = 0;
  let error: string | undefined;
  try {
    for await (const event of agent.runTask(input)) {
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
          usage = event.usage;
          break;
        case "session.completed":
          status = "completed";
          summary = event.report.summary;
          usage = event.report.usage;
          break;
        case "session.failed":
          status = "failed";
          error = `${event.error.code}: ${event.error.message}`;
          break;
        default:
          break;
      }
    }
  } catch (caught) {
    status = "failed";
    error = caught instanceof Error ? caught.message : String(caught);
  }
  if (status === "incomplete") error = "session ended without session.completed or session.failed";
  return {
    status,
    summary,
    usage,
    toolCalls,
    failedToolCalls,
    ...(sessionId ? { sessionId } : {}),
    ...(error ? { error } : {}),
  };
}

function mergeObservation(metrics: MutableMetrics, observation: RunObservation): void {
  if (observation.sessionId) {
    // Core reports cumulative session usage on resume. Replace the prior value
    // for that session instead of double-counting every resumed turn.
    metrics.usageBySession.set(observation.sessionId, observation.usage);
  } else {
    metrics.unboundUsage = addUsage(metrics.unboundUsage, observation.usage);
  }
  metrics.usage = [...metrics.usageBySession.values()].reduce(addUsage, metrics.unboundUsage);
  metrics.toolCalls += observation.toolCalls;
  metrics.failedToolCalls += observation.failedToolCalls;
}

async function runAgentTaskMode(
  task: TaskDef,
  created: CreatedAgent,
  dir: string,
  suffix: string | undefined,
  metrics: MutableMetrics,
): Promise<{ answer: string; execution: TaskExecution; error?: string }> {
  const expected = task.expectedStatus ?? "completed";
  const observation = await observeAgent(created.agent, {
    projectPath: dir,
    task: taskText(task.task, suffix),
    mode: task.mode,
    approvalMode: "auto",
  });
  mergeObservation(metrics, observation);
  const passed = observation.status === expected;
  return {
    answer: observation.summary,
    execution: {
      runner: "agent",
      status: observation.status,
      expectedStatus: expected,
      passed,
      sessionIds: observation.sessionId ? [observation.sessionId] : [],
    },
    ...(!passed ? { error: observation.error ?? `expected ${expected}, got ${observation.status}` } : {}),
  };
}

async function runLoopTaskMode(
  task: TaskDef,
  created: CreatedAgent,
  dir: string,
  suffix: string | undefined,
  opts: RunTaskOptions,
  metrics: MutableMetrics,
): Promise<{ answer: string; execution: TaskExecution; error?: string }> {
  const config = task.loop;
  if (!config) throw new Error(`task ${task.id}: loop runner is missing loop config`);
  if (!created.deps) throw new Error(`task ${task.id}: loop runner requires createAgent() to expose AgentCoreDeps`);
  const run = opts.runLoop ?? runAutoLoop;
  const resume = opts.resumeLoop ?? resumeAutoLoop;
  const initial = await run(created.deps, {
    task: taskText(task.task, suffix),
    workspace: dir,
    verifyCommand: config.verifyCommand,
    maxIterations: config.maxIterations,
    approvalMode: "auto",
    ...(config.costBudgetUsd !== undefined ? { costBudgetUsd: config.costBudgetUsd } : {}),
  });
  let final: LoopResult = initial;
  let statePassed = config.resume === undefined || initial.status === config.resume.expectedInitialStatus;
  if (config.resume !== undefined && statePassed) {
    if (!initial.loopId) throw new Error(`task ${task.id}: loop did not persist a loopId required for resume`);
    final = await resume(created.deps, initial.loopId, {
      workspace: dir,
      approvalMode: "auto",
      ...(config.resume.additionalIterations !== undefined
        ? { additionalIterations: config.resume.additionalIterations }
        : {}),
      ...(config.resume.additionalCostBudgetUsd !== undefined
        ? { additionalCostBudgetUsd: config.resume.additionalCostBudgetUsd }
        : {}),
    });
  }
  statePassed = statePassed && final.status === config.expectedStatus;
  metrics.usage = { ...metrics.usage, costUsd: finiteMetric(final.costUsd) };
  const sessionIds = final.sessionId ? [final.sessionId] : [];
  return {
    answer: final.finalVerify.output,
    execution: {
      runner: "loop",
      status: final.status,
      expectedStatus: config.expectedStatus,
      passed: statePassed,
      sessionIds,
      iterations: final.iterations,
      maxIterations: config.maxIterations + (config.resume?.additionalIterations ?? 0),
      resumed: config.resume !== undefined,
    },
    ...(!statePassed
      ? {
          error:
            config.resume && initial.status !== config.resume.expectedInitialStatus
              ? `expected initial loop status ${config.resume.expectedInitialStatus}, got ${initial.status}`
              : `expected loop status ${config.expectedStatus}, got ${final.status}`,
        }
      : {}),
  };
}

function memoryStep(
  step: Exclude<SessionScenarioStep, { type: "agent" }>,
  dir: string,
  aliases: Map<string, string>,
): void {
  if (step.type === "memory.add") {
    const candidate = addMemoryFact(dir, {
      content: step.content,
      ...(step.memoryType ? { type: step.memoryType } : {}),
      ...(step.approve !== undefined ? { approve: step.approve } : {}),
    });
    aliases.set(step.key, candidate.id);
    return;
  }
  const id = aliases.get(step.key);
  if (!id) throw new Error(`memory alias was not created: ${step.key}`);
  if (step.type === "memory.approve") approveMemoryCandidate(dir, id);
  else rejectMemoryCandidate(dir, id);
}

async function runSessionScenarioMode(
  task: TaskDef,
  created: CreatedAgent,
  dir: string,
  suffix: string | undefined,
  metrics: MutableMetrics,
): Promise<{ answer: string; execution: TaskExecution; error?: string }> {
  if (!task.scenario) throw new Error(`task ${task.id}: session_scenario runner is missing scenario config`);
  const aliases = new Map<string, string>();
  const sessionIds: string[] = [];
  const steps: ExecutionStep[] = [];
  let lastSessionId: string | undefined;
  let answer = "";
  let error: string | undefined;

  for (const [index, step] of task.scenario.steps.entries()) {
    if (step.type !== "agent") {
      try {
        memoryStep(step, dir, aliases);
        steps.push({ index: index + 1, type: step.type, status: "completed", passed: true });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        steps.push({ index: index + 1, type: step.type, status: "failed", passed: false });
        break;
      }
      continue;
    }

    const expected: ExpectedSessionStatus = step.expectedStatus ?? "completed";
    const observation = await observeAgent(created.agent, {
      projectPath: dir,
      task: taskText(step.task ?? task.task, suffix),
      mode: step.mode ?? task.mode,
      approvalMode: "auto",
      ...(step.resume && lastSessionId ? { resumeSessionId: lastSessionId } : {}),
    });
    mergeObservation(metrics, observation);
    answer = observation.summary;
    if (observation.sessionId) {
      lastSessionId = observation.sessionId;
      if (!sessionIds.includes(observation.sessionId)) sessionIds.push(observation.sessionId);
    }
    const passed = observation.status === expected;
    steps.push({
      index: index + 1,
      type: "agent",
      status: observation.status,
      expectedStatus: expected,
      passed,
      ...(observation.sessionId ? { sessionId: observation.sessionId } : {}),
    });
    if (!passed) {
      error = observation.error ?? `scenario step ${index + 1}: expected ${expected}, got ${observation.status}`;
      break;
    }
  }

  const passed =
    error === undefined && steps.length === task.scenario.steps.length && steps.every((step) => step.passed);
  const finalStep = steps.at(-1);
  return {
    answer,
    execution: {
      runner: "session_scenario",
      status: passed ? "completed" : (finalStep?.status ?? "failed"),
      expectedStatus: "completed",
      passed,
      sessionIds,
      resumed: task.scenario.steps.some((step) => step.type === "agent" && step.resume === true),
      steps,
    },
    ...(error ? { error } : {}),
  };
}

function enrichMetricsFromTrace(
  dir: string,
  sessionIds: string[],
  metrics: MutableMetrics,
): Pick<TaskMetrics, "turns" | "score"> {
  const lastSessionId = sessionIds.at(-1);
  if (!lastSessionId) return {};
  try {
    const sessionScore = scoreSession(dir, lastSessionId);
    // Auto-loop does not expose nested AgentEvents; recover its tool metrics and
    // token usage from the shared JSONL/session trace after orchestration ends.
    if (metrics.toolCalls === 0) {
      metrics.toolCalls = sessionScore.metrics.toolCalls;
      metrics.failedToolCalls = sessionScore.metrics.failedToolCalls;
    }
    const meta = readSessionMeta(dir, lastSessionId);
    if (meta?.usage && metrics.usage.promptTokens === 0 && metrics.usage.completionTokens === 0) {
      metrics.usage = meta.usage;
    }
    return { turns: sessionScore.metrics.turns, score: sessionScore.score };
  } catch {
    return {};
  }
}

export async function runTask(task: TaskDef, opts: RunTaskOptions): Promise<TaskResult> {
  const fixtureSrc = join(opts.fixturesDir ?? defaultFixturesDir, task.fixture);
  const dir = await mkdtemp(join(tmpdir(), `seekforge-eval-${task.id}-`));
  try {
    await cp(fixtureSrc, dir, { recursive: true });
    await git(dir, ["init", "-q"]);
    await git(dir, ["add", "-A"]);
    await git(dir, [
      "-c",
      "user.email=eval@seekforge.local",
      "-c",
      "user.name=seekforge-eval",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "fixture baseline",
    ]);

    const startedAt = Date.now();
    const runner = task.runner ?? "agent";
    const metrics: MutableMetrics = {
      usage: ZERO_USAGE,
      usageBySession: new Map(),
      unboundUsage: ZERO_USAGE,
      toolCalls: 0,
      failedToolCalls: 0,
    };
    let created: CreatedAgent | undefined;
    let answer = "";
    let execution: TaskExecution = {
      runner,
      status: "failed",
      expectedStatus: runner === "loop" ? (task.loop?.expectedStatus ?? "passed") : "completed",
      passed: false,
      sessionIds: [],
    };
    let error: string | undefined;
    try {
      created = await opts.createAgent();
      const outcome =
        runner === "loop"
          ? await runLoopTaskMode(task, created, dir, opts.taskSuffix, opts, metrics)
          : runner === "session_scenario"
            ? await runSessionScenarioMode(task, created, dir, opts.taskSuffix, metrics)
            : await runAgentTaskMode(task, created, dir, opts.taskSuffix, metrics);
      answer = outcome.answer;
      execution = outcome.execution;
      error = outcome.error;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      try {
        created?.dispose?.();
      } catch (caught) {
        error ??= `agent cleanup failed: ${caught instanceof Error ? caught.message : String(caught)}`;
      }
    }

    const traceMetrics = enrichMetricsFromTrace(dir, execution.sessionIds, metrics);
    const checks: CheckResult[] = [];
    for (const check of task.checks) checks.push(await evaluateCheck(check, { dir, answer }));
    const skills = await readSkillUsage(dir);
    const promptTokens = finiteMetric(metrics.usage.promptTokens);
    const completionTokens = finiteMetric(metrics.usage.completionTokens);
    const result: TaskResult = {
      taskId: task.id,
      success: execution.passed && error === undefined && checks.every((check) => check.passed),
      checks,
      metrics: {
        ...traceMetrics,
        toolCalls: metrics.toolCalls,
        failedToolCalls: metrics.failedToolCalls,
        costUsd: finiteMetric(metrics.usage.costUsd),
        promptTokens,
        completionTokens,
        cacheHitTokens: finiteMetric(metrics.usage.cacheHitTokens),
        totalTokens: promptTokens + completionTokens,
        durationMs: Date.now() - startedAt,
      },
      skills,
      execution,
    };
    if (opts.keepDir) result.workspaceDir = dir;
    if (error !== undefined) result.error = error;
    return result;
  } finally {
    if (!opts.keepDir) await rm(dir, { recursive: true, force: true });
  }
}
