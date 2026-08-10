// Tests for the `seekforge loop` formatting helpers. No model/core calls — we
// feed synthetic LoopEvent/LoopResult values into the pure formatters. The
// worktree/CLI-spawning cases at the bottom exercise real git repos in temp
// dirs and get generous timeouts (tsx has to compile the CLI per spawn).

import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { Command } from "commander";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireLoopDeliveryLease,
  createLoopState,
  loadLoopState,
  readLoopControlEntries,
  saveLoopState,
  type LoopEvent,
  type LoopResult,
} from "@seekforge/core";
import {
  coreResumeAutoLoop,
  closeLoopPrCi,
  formatLoopEvent,
  formatLoopState,
  formatSummary,
  loopEvidenceCommand,
  loopExitCode,
  outputTail,
  runLoopDelivery,
  runExternalCommand,
  resumeExtensionOptions,
  verificationPlanFromOptions,
} from "../commands/loop.js";
import {
  cleanupLoopWorktree,
  createLoopWorktree,
  formatLoopWorktree,
  isRetainedLoopWorktree,
  resolveLoopRepository,
} from "../loop-worktree.js";
import { setLocale } from "../i18n.js";
import { parseLoopModelRoutes, registerLoopCommands } from "../register-loop.js";

setLocale("en"); // deterministic strings

test("registers the independent review gate and Loop diagnostics", () => {
  const program = new Command();
  registerLoopCommands(program, {
    collect: (value, previous) => [...previous, value],
    parsePositiveInt: Number,
    parseNonNegativeInt: Number,
    parsePositiveFloat: Number,
    rootProfile: () => undefined,
  });
  const loop = program.commands.find((command) => command.name() === "loop");
  assert.equal(
    loop?.options.some((option) => option.long === "--code-review"),
    true,
  );
  assert.equal(
    loop?.options.some((option) => option.long === "--model-route"),
    true,
  );
  assert.equal(
    program.commands
      .find((command) => command.name() === "loop-resume")
      ?.options.some((option) => option.long === "--model-route"),
    true,
  );
  assert.equal(
    program.commands
      .find((command) => command.name() === "loop-dag")
      ?.options.some((option) => option.long === "--model-route"),
    false,
  );
  assert.equal(
    program.commands.some((command) => command.name() === "loop-diagnose"),
    true,
  );
  assert.equal(
    program.commands.some((command) => command.name() === "loop-intelligence"),
    true,
  );
  assert.equal(
    program.commands.some((command) => command.name() === "loop-health"),
    true,
  );
});

test("parses bounded model escalation routes without ambiguous duplicates", () => {
  assert.deepEqual(parseLoopModelRoutes(["compile=fast,strong", "test=tester"]), {
    compile: ["fast", "strong"],
    test: ["tester"],
  });
  assert.throws(() => parseLoopModelRoutes(["compile=fast", "compile=strong"]), /unique/);
  assert.throws(() => parseLoopModelRoutes(["compile=fast,fast"]), /unique/);
  assert.throws(() => parseLoopModelRoutes(["made-up=fast"]), /unique/);
  assert.throws(() => parseLoopModelRoutes(["compile= fast"]), /unique/);
});

// --- outputTail -------------------------------------------------------------
test("outputTail returns the last N non-trailing-blank lines", () => {
  const out = "a\nb\nc\nd\ne\nf\ng\n\n\n";
  assert.equal(outputTail(out, 3), "e\nf\ng");
});
test("outputTail keeps short output verbatim", () => {
  assert.equal(outputTail("only one line"), "only one line");
});
test("outputTail on empty string is empty", () => {
  assert.equal(outputTail(""), "");
});

test("verificationPlanFromOptions validates and orders repeated stages", () => {
  assert.deepEqual(verificationPlanFromOptions({ verify: "pnpm typecheck", verifyStages: ["tests=pnpm test"] }), [
    { id: "verify", command: "pnpm typecheck" },
    { id: "tests", command: "pnpm test" },
  ]);
  assert.deepEqual(
    verificationPlanFromOptions({ verify: "test", verifyStages: ["cli@apps/cli,packages/core=pnpm test"] }),
    [
      { id: "verify", command: "test" },
      { id: "cli", command: "pnpm test", paths: ["apps/cli", "packages/core"] },
    ],
  );
  assert.throws(() => verificationPlanFromOptions({ verify: "test", verifyStages: ["verify=again"] }), /duplicate/);
  assert.throws(() => verificationPlanFromOptions({ verify: "test", verifyStages: ["bad/id=test"] }), /Invalid/);
});

test("external command cancellation remains a distinct control-flow error", async () => {
  const controller = new AbortController();
  const resultPromise = runExternalCommand(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    process.cwd(),
    10_000,
    64 * 1024,
    controller.signal,
  );
  setTimeout(() => controller.abort(), 25);
  const result = await resultPromise;
  assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, "ABORT_ERR");
});

test("green PR checks do not initialize CI repair dependencies", { timeout: 30_000 }, async () => {
  if (process.platform === "win32") return;
  const bin = mkdtempSync(resolve(tmpdir(), "seekforge-loop-gh-"));
  const gh = resolve(bin, "gh");
  const previousPath = process.env.PATH;
  try {
    writeFileSync(gh, "#!/bin/sh\nexit 0\n");
    chmodSync(gh, 0o755);
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    const workspace = bin;
    let prepared = false;
    const updates: Array<Record<string, unknown>> = [];
    const controller = new AbortController();
    const delivered = {
      artifact: "https://example.test/pr/1",
      evidence: { url: "https://example.test/pr/1", branch: "topic" },
      message: "ready",
    };
    const result = await closeLoopPrCi({
      workspace,
      delivered,
      state: createLoopState({
        loopId: "lazy-ci",
        task: "lazy",
        workspace,
        verifyCommand: "true",
        maxIterations: 1,
      }),
      getRepairContext: async () => {
        prepared = true;
        throw new Error("repair context should not be requested");
      },
      maxRepairs: 1,
      repairBudgetUsd: 1,
      signal: controller.signal,
      repairAttempts: 0,
      updateCi: (update) => updates.push(update),
    });
    assert.equal(result, delivered);
    assert.equal(prepared, false);
    assert.equal(updates.at(-1)?.status, "passed");
  } finally {
    process.env.PATH = previousPath;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("cancelled PR check watches remain resumable instead of failed", { timeout: 30_000 }, async () => {
  if (process.platform === "win32") return;
  const bin = mkdtempSync(resolve(tmpdir(), "seekforge-loop-gh-"));
  const gh = resolve(bin, "gh");
  const previousPath = process.env.PATH;
  try {
    writeFileSync(gh, "#!/bin/sh\nsleep 10\n");
    chmodSync(gh, 0o755);
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    const workspace = bin;
    const updates: Array<Record<string, unknown>> = [];
    const controller = new AbortController();
    const closure = closeLoopPrCi({
      workspace,
      delivered: {
        artifact: "https://example.test/pr/1",
        evidence: { url: "https://example.test/pr/1", branch: "topic" },
        message: "ready",
      },
      state: createLoopState({
        loopId: "cancel-ci",
        task: "cancel",
        workspace,
        verifyCommand: "true",
        maxIterations: 1,
      }),
      getRepairContext: async () => {
        throw new Error("repair context should not be requested");
      },
      maxRepairs: 0,
      repairBudgetUsd: 1,
      signal: controller.signal,
      repairAttempts: 0,
      updateCi: (update) => updates.push(update),
    });
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(closure, /cancelled/);
    assert.equal(updates.at(-1)?.status, "pending");
  } finally {
    process.env.PATH = previousPath;
    rmSync(bin, { recursive: true, force: true });
  }
});

// --- formatLoopEvent --------------------------------------------------------
test("iteration.start renders the iteration number", () => {
  const e: LoopEvent = { type: "iteration.start", iteration: 2 };
  assert.match(formatLoopEvent(e), /2/);
});
test("run.completed shows iteration and 4-decimal cost", () => {
  const e: LoopEvent = { type: "run.completed", iteration: 1, costUsd: 0.123456 };
  const line = formatLoopEvent(e);
  assert.match(line, /1/);
  assert.match(line, /0\.1235/); // toFixed(4) rounds
});

test("model routing events expose the selected escalation", () => {
  assert.match(
    formatLoopEvent({
      type: "loop.model.routed",
      iteration: 2,
      category: "compile",
      model: "strong",
      consecutiveFailures: 3,
      candidateIndex: 1,
      reason: "escalated_category",
    }),
    /compile → strong · streak 3 · escalated/,
  );
});
test("verify passed line says PASSED and has no exit code", () => {
  const e: LoopEvent = { type: "verify", iteration: 3, code: 0, passed: true, output: "" };
  const line = formatLoopEvent(e);
  assert.match(line, /PASSED/);
  assert.doesNotMatch(line, /exit/);
});
test("verify failed line shows exit code and the output tail", () => {
  const e: LoopEvent = {
    type: "verify",
    iteration: 4,
    code: 2,
    passed: false,
    output: "line1\nline2\nFAIL: boom",
  };
  const line = formatLoopEvent(e);
  assert.match(line, /FAILED/);
  assert.match(line, /exit 2/);
  assert.match(line, /FAIL: boom/); // tail appended
});
test("verify with empty output emits a single line (no trailing newline)", () => {
  const e: LoopEvent = { type: "verify", iteration: 1, code: 0, passed: true, output: "   \n  " };
  const line = formatLoopEvent(e);
  assert.equal(line.includes("\n"), false);
});
test("requirements events render localized (non-empty) lines through i18n", () => {
  const started: LoopEvent = { type: "requirements.started", phase: "analysis" };
  assert.match(formatLoopEvent(started), /\S/);
  const review: LoopEvent = { type: "requirements.started", phase: "review" };
  assert.match(formatLoopEvent(review), /\S/);
  const completed = {
    type: "requirements.completed",
    spec: { requirements: [{}, {}], acceptanceCriteria: [{}] },
    approvalRequired: true,
  } as unknown as LoopEvent;
  const cLine = formatLoopEvent(completed);
  assert.match(cLine, /2/);
  assert.match(cLine, /1/);
  const reviewed = {
    type: "requirements.reviewed",
    review: { complete: false, gaps: ["missing test"] },
  } as unknown as LoopEvent;
  assert.match(formatLoopEvent(reviewed), /missing test/);
});

// --- formatSummary / loop.done ----------------------------------------------
const result: LoopResult = {
  status: "passed",
  iterations: 3,
  costUsd: 0.5,
  sessionId: "sess_abc123",
  finalVerify: { code: 0, output: "ok" },
};

test("formatSummary includes status, iterations, cost, session id and hints", () => {
  const s = formatSummary(result);
  assert.match(s, /passed/);
  assert.match(s, /3/);
  assert.match(s, /0\.5000/);
  assert.match(s, /sess_abc123/);
  assert.match(s, /seekforge resume sess_abc123/);
  assert.match(s, /seekforge rewind sess_abc123/);
});
test("loop.done event delegates to formatSummary", () => {
  const e: LoopEvent = { type: "loop.done", result };
  assert.equal(formatLoopEvent(e), formatSummary(result));
});
test("formatSummary reflects a non-passed status", () => {
  const s = formatSummary({ ...result, status: "budget" });
  assert.match(s, /budget/);
});
test("formatSummary omits session recovery commands when no session was created", () => {
  const s = formatSummary({ ...result, iterations: 0, costUsd: 0, sessionId: "" });
  assert.match(s, /passed/);
  assert.doesNotMatch(s, /session:/);
  assert.doesNotMatch(s, /seekforge resume/);
  assert.doesNotMatch(s, /seekforge rewind/);
});
test("formatSummary exposes the persisted loop resume id", () => {
  const s = formatSummary({ ...result, loopId: "loop-abc" });
  assert.match(s, /seekforge loop-resume loop-abc/);
});
test("formatSummary includes approval when requirements are pending", () => {
  const s = formatSummary({ ...result, status: "requirements_pending", loopId: "loop-abc" });
  assert.match(s, /seekforge loop-resume loop-abc --approve-requirements/);
});

test("loop exit codes distinguish success, approval pause, and failure", () => {
  assert.equal(loopExitCode("passed"), undefined);
  assert.equal(loopExitCode("requirements_pending"), 2);
  for (const status of ["exhausted", "no_progress", "budget", "cancelled", "verify_error"] as const) {
    assert.equal(loopExitCode(status), 1, status);
  }
});

test("formatLoopWorktree exposes the retained path and branch", () => {
  const text = formatLoopWorktree({ path: "/repo/.seekforge/worktrees/loop-fix", branch: "seekforge/loop-fix" });
  assert.match(text, /retained for inspection/);
  assert.match(text, /\/repo\/\.seekforge\/worktrees\/loop-fix/);
  assert.match(text, /seekforge\/loop-fix/);
});

test("loop resume adapter exposes core support or fails clearly", () => {
  try {
    assert.equal(typeof coreResumeAutoLoop(), "function");
  } catch (err) {
    assert.match(err instanceof Error ? err.message : String(err), /persisted loop resume state/);
  }
});

test("loop resume extensions map to core options without adding absent limits", () => {
  assert.deepEqual(
    resumeExtensionOptions({
      addIters: 3,
      addBudget: 1.25,
      addTokens: 500,
      addDurationSeconds: 2.5,
      addVerifyRuns: 2,
      approveRequirements: true,
    }),
    {
      additionalIterations: 3,
      additionalCostBudgetUsd: 1.25,
      additionalTokenBudget: 500,
      additionalDurationMs: 2500,
      additionalVerifyRuns: 2,
      approveRequirements: true,
    },
  );
  assert.deepEqual(resumeExtensionOptions({}), {});
});

test("formatLoopState includes management-relevant fields", () => {
  const text = formatLoopState({
    loopId: "loop-abc",
    task: "fix tests",
    workspace: "/repo",
    verifyCommand: "pnpm test",
    maxIterations: 8,
    costBudgetUsd: 2,
    iterations: 3,
    costUsd: 0.25,
    sessionId: "session-1",
    lastVerify: null,
    status: "passed",
    delivery: {
      mode: "patch",
      status: "failed",
      attempts: 2,
      updatedAt: "2026-01-02T00:00:00.000Z",
      error: "network unavailable",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  });
  assert.match(text, /loop-abc/);
  assert.match(text, /3\/8/);
  assert.match(text, /\$0\.2500 \/ \$2\.0000/);
  assert.match(text, /pnpm test/);
  assert.match(text, /requirements: quick/);
  assert.match(text, /delivery: patch\/failed\/prepared \(attempts 2\).*network unavailable/);
});

test("requirement events expose analysis and acceptance progress", () => {
  const spec = {
    version: 1 as const,
    goal: "complete feature",
    deliverables: [],
    requirements: [{ id: "REQ-1", text: "feature", required: true }],
    constraints: [],
    outOfScope: [],
    assumptions: [],
    acceptanceCriteria: [{ id: "AC-1", text: "works", requirementIds: ["REQ-1"] }],
    unresolvedQuestions: [],
  };
  assert.match(formatLoopEvent({ type: "requirements.completed", spec, approvalRequired: true }), /approval required/);
  assert.match(
    formatLoopEvent({
      type: "requirements.reviewed",
      review: { complete: false, criteria: [{ id: "AC-1", status: "unmet", evidence: [] }], gaps: ["missing"] },
    }),
    /missing/,
  );
});

test("cleanup safety accepts only seekforge branches inside retained root", () => {
  assert.equal(
    isRetainedLoopWorktree("/repo", {
      path: "/repo/.seekforge/worktrees/loop-fix",
      branch: "seekforge/loop-fix",
    }),
    true,
  );
  assert.equal(isRetainedLoopWorktree("/repo", { path: "/repo", branch: "main" }), false);
  assert.equal(
    isRetainedLoopWorktree("/repo", {
      path: "/repo/.seekforge/worktrees/../outside",
      branch: "seekforge/loop-outside",
    }),
    false,
  );
  assert.equal(
    isRetainedLoopWorktree("/repo", {
      path: "/repo/.seekforge/worktrees/loop-fix",
      branch: "feature/fix",
    }),
    false,
  );
});

test("worktree operations resolve the base checkout from a subdirectory", { timeout: 120_000 }, async () => {
  const repo = mkdtempSync(resolve(tmpdir(), "seekforge-loop-test-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "SeekForge Test"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "initial"], { cwd: repo });
    const subdir = resolve(repo, "nested", "dir");
    mkdirSync(subdir, { recursive: true });

    const created = await createLoopWorktree(subdir, "subdir");
    const canonicalRepo = realpathSync(repo);
    assert.equal(created.path, resolve(canonicalRepo, ".seekforge", "worktrees", "loop-subdir"));
    assert.equal((await resolveLoopRepository(resolve(created.path))).basePath, canonicalRepo);
    assert.deepEqual((await resolveLoopRepository(subdir)).workspaces.sort(), [canonicalRepo, created.path].sort());

    const leaseRoot = resolve(created.path, ".seekforge", "loops");
    const leaseFile = resolve(leaseRoot, ".active-cleanup.lock");
    mkdirSync(leaseRoot, { recursive: true });
    writeFileSync(leaseFile, JSON.stringify({ pid: process.pid, token: "test" }));
    await assert.rejects(cleanupLoopWorktree(subdir, "loop-subdir", true), /active loop/);
    rmSync(leaseFile);

    const lifecycleLease = acquireLoopDeliveryLease(created.path, "active-delivery");
    try {
      await assert.rejects(cleanupLoopWorktree(subdir, "loop-subdir", true), /active operation/);
    } finally {
      lifecycleLease.release();
    }

    const stateInput = { loopId: "duplicate-loop", task: "x", verifyCommand: "true", maxIterations: 1 };
    createLoopState({ ...stateInput, workspace: canonicalRepo });
    createLoopState({ ...stateInput, workspace: created.path });
    const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const tsxLoader = resolve(cliDir, "node_modules/tsx/dist/loader.mjs");
    const duplicate = spawnSync(
      process.execPath,
      ["--import", tsxLoader, resolve(cliDir, "src/index.ts"), "loop-show", "duplicate-loop"],
      {
        cwd: canonicalRepo,
        encoding: "utf8",
      },
    );
    assert.notEqual(duplicate.status, 0);
    assert.match(`${duplicate.stdout}${duplicate.stderr}`, /ambiguous across workspaces/);

    const removed = await cleanupLoopWorktree(subdir, "loop-subdir", true);
    assert.equal(removed.branch, "seekforge/loop-subdir");
    assert.equal(removed.branchRemoved, true);
    assert.throws(() =>
      execFileSync("git", ["show-ref", "--verify", "refs/heads/seekforge/loop-subdir"], { cwd: repo }),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("repository resolution preserves a newline-containing checkout path", { timeout: 60_000 }, async () => {
  const parent = mkdtempSync(resolve(tmpdir(), "seekforge-loop-newline-"));
  const repo = resolve(parent, "repo\ncheckout");
  try {
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "initial"], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "SeekForge Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "SeekForge Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    const resolved = await resolveLoopRepository(repo);
    assert.equal(resolved.basePath, realpathSync(repo));
    assert.deepEqual(resolved.workspaces, [realpathSync(repo)]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("loop state management still works outside a git repository", { timeout: 120_000 }, async () => {
  const workspace = mkdtempSync(resolve(tmpdir(), "seekforge-loop-nongit-"));
  try {
    createLoopState({
      loopId: "nongit-loop",
      task: "local task",
      workspace,
      verifyCommand: "true",
      maxIterations: 1,
    });
    const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        resolve(cliDir, "node_modules/tsx/dist/loader.mjs"),
        resolve(cliDir, "src/index.ts"),
        "loop-show",
        "nongit-loop",
      ],
      { cwd: workspace, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /loop: nongit-loop/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("CLI queues a control for a Loop owned by another live process", { timeout: 120_000 }, () => {
  const workspace = mkdtempSync(resolve(tmpdir(), "seekforge-loop-control-cli-"));
  const loopId = "controlled-loop";
  const runId = "run-cli";
  try {
    createLoopState({
      loopId,
      controlRunId: runId,
      task: "local task",
      workspace,
      verifyCommand: "true",
      maxIterations: 1,
    });
    writeFileSync(
      resolve(workspace, ".seekforge", "loops", `.${loopId}.lock`),
      JSON.stringify({ pid: process.pid, token: "cli-control-test" }),
    );
    const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        resolve(cliDir, "node_modules/tsx/dist/loader.mjs"),
        resolve(cliDir, "src/index.ts"),
        "loop-steer",
        loopId,
        "focus on the parser",
      ],
      { cwd: workspace, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /Queued guidance/);
    const entries = readLoopControlEntries(workspace, loopId, runId);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], {
      operation: "steer",
      message: "focus on the parser",
      seq: 1,
      runId,
      ts: entries[0]?.ts,
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("CLI persists failed delivery attempts and retries the prior mode", { timeout: 120_000 }, () => {
  const workspace = mkdtempSync(resolve(tmpdir(), "seekforge-loop-delivery-cli-"));
  const loopId = "delivery-loop";
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "initial"], {
      cwd: workspace,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "SeekForge Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "SeekForge Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    const state = createLoopState({
      loopId,
      task: "deliver task",
      workspace,
      verifyCommand: "true",
      maxIterations: 1,
    });
    saveLoopState(workspace, { ...state, status: "passed" });
    const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const cli = resolve(cliDir, "src/index.ts");
    const loader = resolve(cliDir, "node_modules/tsx/dist/loader.mjs");
    const first = spawnSync(
      process.execPath,
      ["--import", loader, cli, "loop-deliver", loopId, "--mode", "checkpoint"],
      {
        cwd: workspace,
        encoding: "utf8",
      },
    );
    assert.notEqual(first.status, 0);
    assert.match(`${first.stdout}${first.stderr}`, /isolated retained worktree/);
    assert.deepEqual(loadLoopState(workspace, loopId)?.delivery, {
      mode: "checkpoint",
      status: "failed",
      phase: "prepared",
      attempts: 1,
      updatedAt: loadLoopState(workspace, loopId)?.delivery?.updatedAt,
      error: "Loop delivery requires an isolated retained worktree",
    });

    const changedMode = spawnSync(
      process.execPath,
      ["--import", loader, cli, "loop-deliver", loopId, "--mode", "patch"],
      { cwd: workspace, encoding: "utf8" },
    );
    assert.notEqual(changedMode.status, 0);
    assert.match(`${changedMode.stdout}${changedMode.stderr}`, /mode is already checkpoint/);
    assert.equal(loadLoopState(workspace, loopId)?.delivery?.attempts, 1);

    const retry = spawnSync(process.execPath, ["--import", loader, cli, "loop-deliver", loopId], {
      cwd: workspace,
      encoding: "utf8",
    });
    assert.notEqual(retry.status, 0);
    assert.equal(loadLoopState(workspace, loopId)?.delivery?.attempts, 2);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Loop delivery rejects a concurrent delivery lease", async () => {
  const workspace = mkdtempSync(resolve(tmpdir(), "seekforge-loop-delivery-lock-"));
  const loopId = "delivery-lock";
  const lease = acquireLoopDeliveryLease(workspace, loopId);
  try {
    const state = createLoopState({
      loopId,
      task: "deliver task",
      workspace,
      verifyCommand: "true",
      maxIterations: 1,
    });
    saveLoopState(workspace, { ...state, status: "passed" });
    await assert.rejects(runLoopDelivery(workspace, loopId, "checkpoint"), /delivery is already active/);
  } finally {
    lease.release();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("CLI checkpoints a passed retained Loop and records the artifact", { timeout: 120_000 }, async () => {
  const repo = mkdtempSync(resolve(tmpdir(), "seekforge-loop-delivery-success-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "initial"], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "SeekForge Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "SeekForge Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    const worktree = await createLoopWorktree(repo, "delivery-success");
    writeFileSync(resolve(worktree.path, "result.txt"), "done\n");
    const state = createLoopState({
      loopId: "delivered-loop",
      task: "deliver task",
      workspace: worktree.path,
      verifyCommand: "true",
      maxIterations: 1,
    });
    saveLoopState(worktree.path, { ...state, status: "passed" });
    const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        resolve(cliDir, "node_modules/tsx/dist/loader.mjs"),
        resolve(cliDir, "src/index.ts"),
        "loop-deliver",
        state.loopId,
        "--mode",
        "checkpoint",
      ],
      { cwd: repo, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /Committed Loop worktree/);
    assert.deepEqual(loadLoopState(worktree.path, state.loopId)?.delivery, {
      mode: "checkpoint",
      status: "delivered",
      phase: "finalized",
      attempts: 1,
      updatedAt: loadLoopState(worktree.path, state.loopId)?.delivery?.updatedAt,
      artifact: worktree.branch,
      evidence: {
        branch: worktree.branch,
        revision: loadLoopState(worktree.path, state.loopId)?.delivery?.evidence?.revision,
      },
    });
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: worktree.path, encoding: "utf8" }), "");
    const repeated = spawnSync(
      process.execPath,
      [
        "--import",
        resolve(cliDir, "node_modules/tsx/dist/loader.mjs"),
        resolve(cliDir, "src/index.ts"),
        "loop-deliver",
        state.loopId,
      ],
      { cwd: repo, encoding: "utf8" },
    );
    assert.equal(repeated.status, 0, `${repeated.stdout}${repeated.stderr}`);
    assert.match(repeated.stdout, /already complete/);
    assert.equal(loadLoopState(worktree.path, state.loopId)?.delivery?.attempts, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Loop merge delivery commits finalized state before merging once", { timeout: 120_000 }, async () => {
  const repo = mkdtempSync(resolve(tmpdir(), "seekforge-loop-delivery-merge-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "initial"], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "SeekForge Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "SeekForge Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    const worktree = await createLoopWorktree(repo, "delivery-merge");
    writeFileSync(resolve(worktree.path, "merged.txt"), "merged\n");
    const state = createLoopState({
      loopId: "merged-loop",
      task: "merge delivery task",
      workspace: worktree.path,
      verifyCommand: "true",
      maxIterations: 1,
    });
    saveLoopState(worktree.path, { ...state, status: "passed" });

    await runLoopDelivery(worktree.path, state.loopId, "merge");

    assert.equal(execFileSync("git", ["show", "HEAD:merged.txt"], { cwd: repo, encoding: "utf8" }), "merged\n");
    const mergedState = JSON.parse(
      execFileSync("git", ["show", `HEAD:.seekforge/loops/${state.loopId}.json`], { cwd: repo, encoding: "utf8" }),
    ) as { delivery?: unknown };
    assert.deepEqual(mergedState.delivery, {
      mode: "merge",
      status: "delivered",
      phase: "finalized",
      attempts: 1,
      updatedAt: (mergedState.delivery as { updatedAt?: unknown }).updatedAt,
      artifact: worktree.branch,
      evidence: {
        branch: worktree.branch,
        revision: (mergedState.delivery as { evidence?: { revision?: unknown } }).evidence?.revision,
      },
    });
    assert.equal(execFileSync("git", ["rev-list", "--count", "HEAD^1..HEAD"], { cwd: repo, encoding: "utf8" }), "3\n");

    const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const pruned = spawnSync(
      process.execPath,
      [
        "--import",
        resolve(cliDir, "node_modules/tsx/dist/loader.mjs"),
        resolve(cliDir, "src/index.ts"),
        "loop-prune",
        "--older-than-days",
        "0",
        "--keep-last",
        "0",
        "--worktrees",
      ],
      { cwd: repo, encoding: "utf8" },
    );
    assert.equal(pruned.status, 0, `${pruned.stdout}${pruned.stderr}`);
    assert.match(pruned.stdout, /removed-worktree/);
    assert.equal(existsSync(worktree.path), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Loop delivery rejects branch content added after its evidence revision", { timeout: 120_000 }, async () => {
  const repo = mkdtempSync(resolve(tmpdir(), "seekforge-loop-delivery-scope-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "SeekForge Test"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "initial"], { cwd: repo });
    const worktree = await createLoopWorktree(repo, "delivery-scope");
    writeFileSync(resolve(worktree.path, "verified.txt"), "verified\n");
    execFileSync("git", ["add", "verified.txt"], { cwd: worktree.path });
    execFileSync("git", ["commit", "-qm", "verified"], { cwd: worktree.path });
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree.path, encoding: "utf8" }).trim();
    const state = createLoopState({
      loopId: "delivery-scope-loop",
      task: "deliver only verified content",
      workspace: worktree.path,
      verifyCommand: "true",
      maxIterations: 1,
    });
    saveLoopState(worktree.path, {
      ...state,
      status: "passed",
      delivery: {
        mode: "merge",
        status: "failed",
        phase: "action_completed",
        attempts: 1,
        updatedAt: new Date().toISOString(),
        artifact: worktree.branch,
        evidence: { branch: worktree.branch, revision },
        error: "simulated interruption",
      },
    });
    writeFileSync(resolve(worktree.path, "unverified.txt"), "unverified\n");
    execFileSync("git", ["add", "unverified.txt"], { cwd: worktree.path });
    execFileSync("git", ["commit", "-qm", "unverified later commit"], { cwd: worktree.path });
    writeFileSync(resolve(worktree.path, "working-tree-only.txt"), "unverified and uncommitted\n");

    await assert.rejects(
      runLoopDelivery(worktree.path, state.loopId, "merge"),
      /unverified changes.*unverified\.txt.*working-tree-only\.txt/,
    );
    const failed = loadLoopState(worktree.path, state.loopId);
    assert.ok(failed);
    saveLoopState(worktree.path, {
      ...failed,
      delivery: {
        mode: "merge",
        status: "delivered",
        phase: "finalized",
        attempts: 2,
        updatedAt: new Date().toISOString(),
        artifact: worktree.branch,
        evidence: { branch: worktree.branch, revision },
      },
    });
    await assert.rejects(
      runLoopDelivery(worktree.path, state.loopId, "merge"),
      /unverified changes.*unverified\.txt.*working-tree-only\.txt/,
    );
    assert.throws(() => execFileSync("git", ["show", "HEAD:unverified.txt"], { cwd: repo }), /Command failed/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Loop delivery reruns verification after checkpointing the publication tree", { timeout: 120_000 }, async () => {
  const repo = mkdtempSync(resolve(tmpdir(), "seekforge-loop-delivery-reverify-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "SeekForge Test"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "initial"], { cwd: repo });
    const worktree = await createLoopWorktree(repo, "delivery-reverify");
    const state = createLoopState({
      loopId: "delivery-reverify-loop",
      task: "reject post-verification drift",
      workspace: worktree.path,
      verifyCommand: "test ! -e added-after-pass.txt",
      maxIterations: 1,
    });
    saveLoopState(worktree.path, { ...state, status: "passed" });
    writeFileSync(resolve(worktree.path, "added-after-pass.txt"), "not verified\n");

    await assert.rejects(runLoopDelivery(worktree.path, state.loopId, "merge"), /delivery verification failed/);
    assert.throws(() => execFileSync("git", ["show", "HEAD:added-after-pass.txt"], { cwd: repo }), /Command failed/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Loop delivery rejects files created by the finalized-state commit hook", { timeout: 120_000 }, async () => {
  const repo = mkdtempSync(resolve(tmpdir(), "seekforge-loop-delivery-hook-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "SeekForge Test"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "initial"], { cwd: repo });
    const worktree = await createLoopWorktree(repo, "delivery-hook");
    writeFileSync(resolve(worktree.path, "verified.txt"), "verified\n");
    const state = createLoopState({
      loopId: "delivery-hook-loop",
      task: "reject hook drift",
      workspace: worktree.path,
      verifyCommand: "true",
      maxIterations: 1,
    });
    saveLoopState(worktree.path, { ...state, status: "passed" });
    const gitCommonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: worktree.path,
      encoding: "utf8",
    }).trim();
    const hook = resolve(worktree.path, gitCommonDir, "hooks", "post-commit");
    writeFileSync(
      hook,
      '#!/bin/sh\nsubject=$(git log -1 --pretty=%s)\nif [ "$subject" = "chore: record delivery-hook-loop delivery" ]; then\n  printf "hook\\n" > hook-generated.txt\nfi\n',
      { mode: 0o755 },
    );

    await assert.rejects(runLoopDelivery(worktree.path, state.loopId, "merge"), /publication scope changed/);
    assert.throws(() => execFileSync("git", ["show", "HEAD:hook-generated.txt"], { cwd: repo }), /Command failed/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Loop delivery persists mandatory CI closure across retries", { timeout: 120_000 }, async () => {
  const repo = mkdtempSync(resolve(tmpdir(), "seekforge-loop-delivery-ci-state-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "SeekForge Test"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "initial"], { cwd: repo });
    const remote = resolve(repo, "remote.git");
    execFileSync("git", ["init", "--bare", "-q", remote], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });
    const worktree = await createLoopWorktree(repo, "delivery-ci-state");
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree.path, encoding: "utf8" }).trim();
    const state = createLoopState({
      loopId: "delivery-ci-state-loop",
      task: "retain CI policy",
      workspace: worktree.path,
      verifyCommand: "true",
      maxIterations: 1,
    });
    saveLoopState(worktree.path, {
      ...state,
      status: "passed",
      delivery: {
        mode: "pr",
        status: "failed",
        phase: "action_completed",
        attempts: 1,
        updatedAt: new Date().toISOString(),
        artifact: "https://example.test/pr/1",
        evidence: { branch: worktree.branch, revision, url: "https://example.test/pr/1" },
        error: "interrupted",
      },
    });
    await assert.rejects(
      runLoopDelivery(worktree.path, state.loopId, "pr", {
        ciPolicy: { maxRepairs: 1, repairBudgetUsd: 0.5 },
        beforeFinalize: async (_delivered, _current, updateCi) => {
          updateCi({ status: "failed", repairAttempts: 0, error: "checks failed" });
          throw new Error("checks failed");
        },
      }),
      /checks failed/,
    );
    assert.equal(loadLoopState(worktree.path, state.loopId)?.delivery?.ci?.status, "failed");
    await assert.rejects(runLoopDelivery(worktree.path, state.loopId, "pr"), /requires CI closure/);
    await runLoopDelivery(worktree.path, state.loopId, "pr", {
      ciPolicy: { maxRepairs: 1, repairBudgetUsd: 0.5 },
      beforeFinalize: async (delivered, _current, updateCi) => {
        updateCi({ status: "passed", repairAttempts: 0, error: undefined });
        return delivered;
      },
    });
    assert.equal(loadLoopState(worktree.path, state.loopId)?.delivery?.status, "delivered");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Loop cleanup and pruning preserve a branch with later unmerged commits", { timeout: 120_000 }, async () => {
  const repo = mkdtempSync(resolve(tmpdir(), "seekforge-loop-prune-ahead-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "SeekForge Test"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "initial"], { cwd: repo });
    const worktree = await createLoopWorktree(repo, "prune-ahead");
    const old = "2025-01-01T00:00:00.000Z";
    const state = createLoopState({
      loopId: "prune-ahead-loop",
      task: "retain later commit",
      workspace: worktree.path,
      verifyCommand: "true",
      maxIterations: 1,
    });
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree.path,
      encoding: "utf8",
    }).trim();
    saveLoopState(worktree.path, {
      ...state,
      status: "passed",
      updatedAt: old,
      delivery: {
        mode: "merge",
        status: "delivered",
        phase: "finalized",
        attempts: 1,
        artifact: worktree.branch,
        evidence: { branch: worktree.branch, revision },
        updatedAt: old,
      },
    });
    execFileSync("git", ["add", "-A"], { cwd: worktree.path });
    execFileSync("git", ["commit", "-qm", "finalized state"], { cwd: worktree.path });
    execFileSync("git", ["merge", "--no-ff", worktree.branch, "-m", "merge delivered"], { cwd: repo });
    writeFileSync(resolve(worktree.path, "later.txt"), "not merged\n");
    execFileSync("git", ["add", "later.txt"], { cwd: worktree.path });
    execFileSync("git", ["commit", "-qm", "later unmerged work"], { cwd: worktree.path });

    await assert.rejects(cleanupLoopWorktree(repo, worktree.branch), /unmerged commits/);
    const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const pruned = spawnSync(
      process.execPath,
      [
        "--import",
        resolve(cliDir, "node_modules/tsx/dist/loader.mjs"),
        resolve(cliDir, "src/index.ts"),
        "loop-prune",
        "--older-than-days",
        "0",
        "--keep-last",
        "0",
        "--worktrees",
      ],
      { cwd: repo, encoding: "utf8" },
    );
    assert.equal(pruned.status, 0, `${pruned.stdout}${pruned.stderr}`);
    assert.match(pruned.stdout, /skipped-worktree.*unmerged commits/);
    assert.equal(existsSync(worktree.path), true);
    assert.doesNotThrow(() =>
      execFileSync("git", ["show-ref", "--verify", `refs/heads/${worktree.branch}`], { cwd: repo }),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Loop delivery repairs a legacy delivered checkpoint before returning success", { timeout: 120_000 }, async () => {
  const repo = mkdtempSync(resolve(tmpdir(), "seekforge-loop-delivery-repair-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "initial"], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "SeekForge Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "SeekForge Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    const worktree = await createLoopWorktree(repo, "delivery-repair");
    writeFileSync(resolve(worktree.path, "result.txt"), "done\n");
    const state = createLoopState({
      loopId: "legacy-delivered",
      task: "deliver task",
      workspace: worktree.path,
      verifyCommand: "true",
      maxIterations: 1,
    });
    saveLoopState(worktree.path, {
      ...state,
      status: "passed",
      delivery: {
        mode: "checkpoint",
        status: "delivered",
        attempts: 1,
        updatedAt: new Date().toISOString(),
        artifact: worktree.branch,
      },
    });

    const delivered = await runLoopDelivery(worktree.path, state.loopId, "checkpoint");
    assert.match(delivered.message, /Committed Loop worktree/);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: worktree.path, encoding: "utf8" }), "");
    assert.equal(execFileSync("git", ["show", "HEAD:result.txt"], { cwd: worktree.path, encoding: "utf8" }), "done\n");
    assert.equal(loadLoopState(worktree.path, state.loopId)?.delivery?.attempts, 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Loop patch retry replaces a stale artifact without embedding it", { timeout: 120_000 }, async () => {
  const repo = mkdtempSync(resolve(tmpdir(), "seekforge-loop-patch-retry-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "initial"], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "SeekForge Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "SeekForge Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    const worktree = await createLoopWorktree(repo, "patch-retry");
    writeFileSync(resolve(worktree.path, "result.txt"), "done\n");
    const state = createLoopState({
      loopId: "patch-retry-loop",
      task: "deliver patch",
      workspace: worktree.path,
      verifyCommand: "true",
      maxIterations: 1,
    });
    const artifact = resolve(worktree.path, ".seekforge", "loops", `${state.loopId}.patch`);
    saveLoopState(worktree.path, {
      ...state,
      status: "passed",
      delivery: {
        mode: "patch",
        status: "failed",
        attempts: 1,
        updatedAt: new Date().toISOString(),
        error: "interrupted after writing an older artifact",
      },
    });
    writeFileSync(artifact, "STALE_PATCH_PAYLOAD\n");

    const delivered = await runLoopDelivery(worktree.path, state.loopId, "patch");
    assert.equal(delivered.artifact, artifact);
    assert.match(readFileSync(artifact, "utf8"), /result\.txt/);
    assert.doesNotMatch(readFileSync(artifact, "utf8"), /STALE_PATCH_PAYLOAD/);
    assert.equal(loadLoopState(worktree.path, state.loopId)?.delivery?.status, "delivered");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI numeric parsers reject trailing junk and non-finite values globally", { timeout: 120_000 }, () => {
  const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const cli = resolve(cliDir, "src/index.ts");
  for (const args of [
    ["run", "task", "--max-turns", "2x"],
    ["run", "task", "--max-cost", "1.5usd"],
    ["loop", "task", "--verify", "true", "--max-iters", "3.0"],
    ["loop-resume", "loop-abc", "--add-budget", "1e999"],
  ]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
      cwd: cliDir,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(`${result.stdout}${result.stderr}`, /positive (?:integer|number)/);
  }
});

test("loop-evidence verifies the integrity digest it has always exported", async () => {
  const workspace = realpathSync(mkdtempSync(resolve(tmpdir(), "seekforge-loop-evidence-")));
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(workspace);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    saveLoopState(
      workspace,
      createLoopState({ loopId: "evidence-cli", task: "t", workspace, verifyCommand: "true", maxIterations: 1 }),
    );
    await loopEvidenceCommand("evidence-cli");
    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    assert.ok(report.integrity, "the exported report carries its digest");

    writeFileSync(resolve(workspace, "ok.json"), JSON.stringify(report));
    await loopEvidenceCommand(undefined, { verify: "ok.json" });
    assert.match(String(log.mock.calls.at(-1)?.[0]), /intact/);
    assert.equal(process.exitCode, undefined);

    // Editing a report after export must be detectable; that is the whole point
    // of the digest, and until now nothing shipped could check it.
    writeFileSync(resolve(workspace, "bad.json"), JSON.stringify({ ...report, status: "passed" }));
    await loopEvidenceCommand(undefined, { verify: "bad.json" });
    assert.match(String(log.mock.calls.at(-1)?.[0]), /tampered/);
    assert.equal(process.exitCode, 1);
    process.exitCode = undefined;

    await loopEvidenceCommand(undefined, {});
    assert.match(String(stderr.mock.calls.at(-1)?.[0]), /loop-id is required/);
    process.exitCode = undefined;
  } finally {
    cwd.mockRestore();
    log.mockRestore();
    stderr.mockRestore();
    rmSync(workspace, { recursive: true, force: true });
  }
});
