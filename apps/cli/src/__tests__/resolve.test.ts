// Regression tests for the PURE builders behind `seekforge resolve` (the
// autonomous GitHub issue→PR resolver). No live agent, no `gh`, no `git`, no
// push: the argv/prompt construction IS the verification. Dependency-free
// runner (via `tsx`): each case asserts with node:assert and exits non-zero on
// the first failure.

import assert from "node:assert/strict";
import {
  BRANCH_PREFIX,
  DEFAULT_BASE_BRANCH,
  InvalidIssueError,
  buildAddArgs,
  buildBranchArgs,
  buildBranchName,
  buildCommitArgs,
  buildCommitMessage,
  buildDetachedWorktreeArgs,
  buildIssueViewArgs,
  buildPrChecksArgs,
  buildPrCheckoutArgs,
  buildPrBody,
  buildPrCreateArgs,
  buildPrViewArgs,
  buildPrTitle,
  buildPushArgs,
  buildReviewPushArgs,
  buildReviewTaskPrompt,
  buildTaskPrompt,
  buildWorktreeAddArgs,
  buildWorktreeRemoveArgs,
  formatCommand,
  parseIssueNumber,
  type IssueRef,
} from "../resolve.js";

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  }
}

/** Return the value token that follows `flag` in argv, or undefined. */
function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const ISSUE: IssueRef = { number: 42, title: "Crash on empty input", body: "Steps:\n1. run it\n2. boom" };

// --- issue-number parsing: number / URL / invalid ---------------------------
test("parses a bare issue number", () => {
  assert.equal(parseIssueNumber("42"), 42);
});

test("parses a #-prefixed number", () => {
  assert.equal(parseIssueNumber("#42"), 42);
});

test("trims surrounding whitespace", () => {
  assert.equal(parseIssueNumber("  7 "), 7);
});

test("parses the number out of a full GitHub issue URL", () => {
  assert.equal(parseIssueNumber("https://github.com/owner/repo/issues/123"), 123);
});

test("parses a URL with a trailing slash and query/fragment", () => {
  assert.equal(parseIssueNumber("https://github.com/o/r/issues/9/"), 9);
  assert.equal(parseIssueNumber("https://github.com/o/r/issues/9?foo=bar"), 9);
  assert.equal(parseIssueNumber("https://github.com/o/r/issues/9#comment"), 9);
});

test("rejects zero, negatives, non-numeric, empty, and non-issue URLs", () => {
  for (const bad of ["0", "-3", "abc", "", "   ", "12x", "https://github.com/o/r/pulls", "https://example.com/foo/1"]) {
    assert.throws(() => parseIssueNumber(bad), InvalidIssueError, `expected "${bad}" to throw`);
  }
});

// --- branch name ------------------------------------------------------------
test("branch name is seekforge/issue-<n>", () => {
  assert.equal(buildBranchName(42), "seekforge/issue-42");
  assert.ok(buildBranchName(42).startsWith(BRANCH_PREFIX));
});

test("git checkout -b uses the derived branch", () => {
  assert.deepEqual(buildBranchArgs("seekforge/issue-42"), ["checkout", "-b", "seekforge/issue-42"]);
});

test("isolated worktree args create a branch from the requested base", () => {
  assert.deepEqual(buildWorktreeAddArgs("/tmp/work", "seekforge/issue-42", "develop"), [
    "worktree", "add", "-b", "seekforge/issue-42", "/tmp/work", "develop",
  ]);
  assert.deepEqual(buildDetachedWorktreeArgs("/tmp/review"), ["worktree", "add", "--detach", "/tmp/review"]);
  assert.deepEqual(buildWorktreeRemoveArgs("/tmp/work"), ["worktree", "remove", "/tmp/work"]);
  assert.deepEqual(buildWorktreeRemoveArgs("/tmp/work", true), ["worktree", "remove", "--force", "/tmp/work"]);
});

// --- task prompt ------------------------------------------------------------
test("task prompt has the objective header, body, and the minimal-change directive", () => {
  const p = buildTaskPrompt(ISSUE);
  assert.ok(p.startsWith("Resolve GitHub issue #42: Crash on empty input"));
  assert.ok(p.includes("1. run it"));
  assert.ok(p.includes("Make the minimal change that fixes it and ensure tests pass."));
});

test("task prompt omits an empty body cleanly (no dangling blank lines)", () => {
  const p = buildTaskPrompt({ number: 5, title: "No body", body: "   " });
  assert.equal(p, "Resolve GitHub issue #5: No body\n\nMake the minimal change that fixes it and ensure tests pass.");
  assert.ok(!p.includes("\n\n\n"));
});

// --- gh issue view argv (read-only fetch) -----------------------------------
test("gh issue view fetches title,body,number as JSON", () => {
  assert.deepEqual(buildIssueViewArgs(42), ["issue", "view", "42", "--json", "title,body,number"]);
});

// --- git add / commit -------------------------------------------------------
test("git add stages everything (-A)", () => {
  assert.deepEqual(buildAddArgs(), ["add", "-A"]);
});

test("commit message references the issue", () => {
  const msg = buildCommitMessage(ISSUE);
  assert.equal(msg, "Resolve #42: Crash on empty input");
  assert.deepEqual(buildCommitArgs(msg), ["commit", "-m", "Resolve #42: Crash on empty input"]);
});

// --- git push ---------------------------------------------------------------
test("push targets origin and sets upstream for the work branch", () => {
  assert.deepEqual(buildPushArgs("seekforge/issue-42"), ["push", "-u", "origin", "seekforge/issue-42"]);
});

test("review fixes push to the checked-out PR branch upstream", () => {
  assert.deepEqual(buildReviewPushArgs(), ["push"]);
});

// --- gh pr create argv ------------------------------------------------------
test("pr create defaults to a draft, base main, head branch, and Resolves #<n> body", () => {
  const args = buildPrCreateArgs({ issue: ISSUE, branch: "seekforge/issue-42" });
  assert.equal(valueAfter(args, "--base"), DEFAULT_BASE_BRANCH);
  assert.equal(valueAfter(args, "--head"), "seekforge/issue-42");
  assert.equal(valueAfter(args, "--title"), "Resolve #42: Crash on empty input");
  assert.ok(valueAfter(args, "--body")!.startsWith("Resolves #42"));
  assert.ok(args.includes("--draft"), "draft is the default");
});

test("--no-draft (draft:false) omits the --draft flag", () => {
  const args = buildPrCreateArgs({ issue: ISSUE, branch: "b", draft: false });
  assert.ok(!args.includes("--draft"));
});

test("a custom base branch is honored", () => {
  const args = buildPrCreateArgs({ issue: ISSUE, branch: "b", base: "develop" });
  assert.equal(valueAfter(args, "--base"), "develop");
});

test("a run summary is appended under Resolves #<n>", () => {
  assert.equal(buildPrBody(42), "Resolves #42");
  assert.equal(buildPrBody(42, "Fixed the null deref."), "Resolves #42\n\nFixed the null deref.");
});

test("pr title matches the commit subject", () => {
  assert.equal(buildPrTitle(ISSUE), buildCommitMessage(ISSUE));
});

test("CI checks use watch and fail-fast", () => {
  assert.deepEqual(buildPrChecksArgs("https://github.com/o/r/pull/42"), [
    "pr", "checks", "https://github.com/o/r/pull/42", "--watch", "--fail-fast",
  ]);
});

test("review mode fetches context and checks out the requested PR", () => {
  assert.deepEqual(buildPrViewArgs("42"), [
    "pr", "view", "42", "--json", "number,title,body,comments,reviews,headRefName",
  ]);
  assert.deepEqual(buildPrCheckoutArgs("42"), ["pr", "checkout", "42"]);
});

test("review prompt includes comments and limits the task to actionable feedback", () => {
  const prompt = buildReviewTaskPrompt({
    number: 42,
    title: "Fix crash",
    comments: [{ body: "Add a null guard" }],
    reviews: [{ state: "CHANGES_REQUESTED", body: "Please add a test" }],
  });
  assert.ok(prompt.includes("PR #42: Fix crash"));
  assert.ok(prompt.includes("Add a null guard"));
  assert.ok(prompt.includes("CHANGES_REQUESTED"));
  assert.ok(prompt.includes("only changes required by actionable review feedback"));
});

test("review prompt bounds untrusted GitHub context", () => {
  const prompt = buildReviewTaskPrompt({ number: 42, title: "Fix", comments: [{ body: "x".repeat(30_000) }] });
  assert.ok(prompt.includes("[truncated]"));
  assert.ok(prompt.length < 21_000);
});

// --- formatting -------------------------------------------------------------
test("formatCommand prefixes the binary and quotes multi-word args", () => {
  const line = formatCommand("gh", buildPrCreateArgs({ issue: ISSUE, branch: "seekforge/issue-42" }));
  assert.ok(line.startsWith("gh pr create "));
  assert.ok(line.includes('"Resolve #42: Crash on empty input"'));
});

// --- the command requires --max-cost (guards direct callers) ----------------
// resolveCommand fails fast (via colors.fail → process.exitCode) before any
// gh/git/agent work when --max-cost is missing or non-positive. We capture
// stderr and assert nothing was spawned (no PR-shaped output on stdout).
import { resolveCommand } from "../commands/resolve.js";

async function expectMaxCostRequired(badCost: unknown): Promise<void> {
  const errs: string[] = [];
  const outs: string[] = [];
  // colors.fail() writes to process.stderr.write; console.log to stdout.
  const realErrWrite = process.stderr.write.bind(process.stderr);
  const realLog = console.log;
  const prevExit = process.exitCode;
  process.stderr.write = ((chunk: unknown) => {
    errs.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  console.log = (...a: unknown[]) => void outs.push(a.join(" "));
  try {
    await resolveCommand("42", { maxCost: badCost as number });
  } finally {
    process.stderr.write = realErrWrite;
    console.log = realLog;
  }
  assert.ok(
    errs.some((e) => e.includes("--max-cost")),
    `expected a --max-cost error for cost=${String(badCost)}`,
  );
  assert.ok(!outs.some((o) => o.includes("opened PR")), "must not reach the PR step");
  process.exitCode = prevExit; // don't leak the fail()'s exit code into the runner
}

await expectMaxCostRequired(undefined);
await expectMaxCostRequired(0);
await expectMaxCostRequired(-1);
passed += 3;

console.log(`resolve: ${passed} assertions passed`);
