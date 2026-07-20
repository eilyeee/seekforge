// Tests for the `seekforge loop` formatting helpers. No model/core calls — we
// feed synthetic LoopEvent/LoopResult values into the pure formatters. The
// worktree/CLI-spawning cases at the bottom exercise real git repos in temp
// dirs and get generous timeouts (tsx has to compile the CLI per spawn).

import assert from "node:assert/strict";
import { test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoopState, type LoopEvent, type LoopResult } from "@seekforge/core";
import {
  coreResumeAutoLoop,
  formatLoopEvent,
  formatLoopState,
  formatSummary,
  outputTail,
  resumeExtensionOptions,
} from "../commands/loop.js";
import {
  cleanupLoopWorktree,
  createLoopWorktree,
  formatLoopWorktree,
  isRetainedLoopWorktree,
  resolveLoopRepository,
} from "../loop-worktree.js";
import { setLocale } from "../i18n.js";

setLocale("en"); // deterministic strings

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
  assert.deepEqual(resumeExtensionOptions({ addIters: 3, addBudget: 1.25, approveRequirements: true }), {
    additionalIterations: 3,
    additionalCostBudgetUsd: 1.25,
    approveRequirements: true,
  });
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
    status: "exhausted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  });
  assert.match(text, /loop-abc/);
  assert.match(text, /3\/8/);
  assert.match(text, /\$0\.2500 \/ \$2\.0000/);
  assert.match(text, /pnpm test/);
  assert.match(text, /requirements: quick/);
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
