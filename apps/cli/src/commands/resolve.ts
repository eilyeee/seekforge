/** User-triggered GitHub issue-to-PR and review-fix workflows. */

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail } from "../colors.js";
import { loadConfig } from "../config.js";
import {
  DEFAULT_BASE_BRANCH,
  InvalidIssueError,
  buildAddArgs,
  buildBranchArgs,
  buildBranchExistsArgs,
  buildBranchName,
  buildCommitArgs,
  buildCommitMessage,
  buildDetachedWorktreeArgs,
  buildCiRepairPrompt,
  buildFailedRunListArgs,
  buildFailedRunLogArgs,
  buildIssueViewArgs,
  buildPrChecksArgs,
  buildPrCheckoutArgs,
  buildPrCreateArgs,
  buildPrViewArgs,
  buildPushArgs,
  buildReviewPushArgs,
  buildReviewTaskPrompt,
  buildTaskPrompt,
  buildWorktreeAddArgs,
  buildWorktreeRemoveArgs,
  buildWorktreeReuseArgs,
  formatCommand,
  parseIssueNumber,
  type IssueRef,
  type ReviewContext,
} from "../resolve.js";
import { runTaskCommand } from "./run.js";

export type ResolveOptions = {
  maxCost: number;
  base?: string;
  model?: string;
  draft?: boolean;
  dryRun?: boolean;
  worktree?: boolean;
  waitCi?: boolean;
};

export type ResolveReviewOptions = {
  maxCost: number;
  model?: string;
  dryRun?: boolean;
  worktree?: boolean;
  waitCi?: boolean;
};

type Result = { code: number; stdout: string; stderr: string; missing: boolean };

function run(bin: string, args: string[], cwd = process.cwd()): Result {
  const result = spawnSync(bin, args, { cwd, encoding: "utf8" });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { code: 127, stdout: "", stderr: "", missing: true };
  }
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    missing: false,
  };
}

function prerequisites(projectPath: string): boolean {
  if (run("gh", ["--version"], projectPath).missing) {
    fail("the GitHub CLI (`gh`) was not found on PATH", {
      hint: "install it from https://cli.github.com and run `gh auth login`",
    });
    return false;
  }
  const origin = run("git", ["remote", "get-url", "origin"], projectPath);
  if (origin.code !== 0 || origin.stdout.trim() === "") {
    fail("this repository has no `origin` remote", { hint: "add one with: git remote add origin <url>" });
    return false;
  }
  return true;
}

function validBudget(maxCost: number): boolean {
  if (typeof maxCost === "number" && Number.isFinite(maxCost) && maxCost > 0) return true;
  fail("--max-cost <usd> is required (an autonomous fix must be cost-bounded)", {
    hint: "e.g. seekforge resolve 42 --max-cost 1.00",
  });
  return false;
}

function verify(projectPath: string, cwd: string): boolean {
  const config = loadConfig(projectPath);
  for (const [label, command] of [["verify", config.verifyCommand], ["lint", config.lintCommand]] as const) {
    if (!command?.trim()) continue;
    console.log(`\n  running ${label} command: ${command}`);
    const result = spawnSync(command, { cwd, shell: true, stdio: "inherit" });
    if ((result.status ?? 1) !== 0) {
      fail(`${label} command failed — not committing or pushing`, { hint: `fix the failures in ${cwd}` });
      return false;
    }
  }
  return true;
}

function changed(cwd: string): boolean {
  const status = run("git", ["status", "--porcelain"], cwd);
  return status.code === 0 && status.stdout.trim() !== "";
}

function createTempWorktreePath(): string {
  return mkdtempSync(join(tmpdir(), "seekforge-resolve-"));
}

function removeWorktree(projectPath: string, path: string, force: boolean): void {
  run("git", buildWorktreeRemoveArgs(path, force), projectPath);
}

function existingBranch(projectPath: string, branch: string): boolean {
  return run("git", buildBranchExistsArgs(branch), projectPath).code === 0;
}

async function repairFailedCi(
  projectPath: string,
  workPath: string,
  branch: string,
  maxCost: number,
  model: string | undefined,
): Promise<boolean> {
  const listed = run("gh", buildFailedRunListArgs(branch), workPath);
  if (listed.code !== 0) return false;
  let runId: number | undefined;
  try {
    const parsed: unknown = JSON.parse(listed.stdout);
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null) {
      const value = (parsed[0] as Record<string, unknown>)["databaseId"];
      if (Number.isSafeInteger(value) && (value as number) > 0) runId = value as number;
    }
  } catch {
    return false;
  }
  if (runId === undefined) return false;
  const logs = run("gh", buildFailedRunLogArgs(runId), workPath);
  if (logs.code !== 0 || logs.stdout.trim() === "") return false;
  const completed = await runTaskCommand(buildCiRepairPrompt(logs.stdout), {
    mode: "edit",
    permissionMode: "acceptEdits",
    maxCostUsd: maxCost,
    model,
  });
  if (!completed || !changed(workPath) || !verify(projectPath, workPath)) return false;
  for (const args of [buildAddArgs(), buildCommitArgs(`Fix CI for ${branch}`), buildPushArgs(branch)]) {
    const result = run("git", args, workPath);
    if (result.code !== 0) return false;
  }
  return true;
}

export async function resolveCommand(issueArg: string, opts: ResolveOptions): Promise<void> {
  const projectPath = process.cwd();
  if (!validBudget(opts.maxCost)) return;

  let issueNumber: number;
  try {
    issueNumber = parseIssueNumber(issueArg);
  } catch (error) {
    if (error instanceof InvalidIssueError) {
      fail(error.message);
      return;
    }
    throw error;
  }
  if (!prerequisites(projectPath)) return;

  const view = run("gh", buildIssueViewArgs(issueNumber), projectPath);
  if (view.code !== 0) {
    fail(`failed to fetch issue #${issueNumber} via \`gh issue view\``, { hint: view.stderr.trim() || undefined });
    return;
  }

  let issue: IssueRef;
  try {
    const parsed = JSON.parse(view.stdout) as Partial<IssueRef>;
    issue = { number: parsed.number ?? issueNumber, title: parsed.title ?? "", body: parsed.body ?? "" };
  } catch {
    fail("could not parse the `gh issue view` JSON output");
    return;
  }

  const branch = buildBranchName(issue.number);
  const base = opts.base?.trim() || DEFAULT_BASE_BRANCH;
  const useWorktree = opts.worktree ?? true;
  const workPath = useWorktree ? createTempWorktreePath() : projectPath;
  const reuseBranch = existingBranch(projectPath, branch);
  const branchResult = useWorktree
    ? run("git", reuseBranch ? buildWorktreeReuseArgs(workPath, branch) : buildWorktreeAddArgs(workPath, branch, base), projectPath)
    : run("git", reuseBranch ? ["checkout", branch] : buildBranchArgs(branch), projectPath);
  if (branchResult.code !== 0) {
    fail(`failed to create work branch "${branch}"`, { hint: branchResult.stderr.trim() || undefined });
    return;
  }

  console.log(`▶ resolving issue #${issue.number}: ${issue.title}`);
  if (useWorktree) console.log(`  isolated worktree: ${workPath}`);
  let removeOnExit = false;
  const originalCwd = process.cwd();
  try {
    process.chdir(workPath);
    const completed = await runTaskCommand(buildTaskPrompt(issue), {
      mode: "edit",
      permissionMode: "acceptEdits",
      maxCostUsd: opts.maxCost,
      model: opts.model,
    });
    if (!completed) {
      removeOnExit = useWorktree;
      fail("the agent run did not complete — not committing or opening a PR");
      return;
    }
    if (!changed(workPath)) {
      removeOnExit = useWorktree;
      fail("the agent made no changes — nothing to commit or open a PR for");
      return;
    }
    if (!verify(projectPath, workPath)) return;

    const commitArgs = buildCommitArgs(buildCommitMessage(issue));
    const pushArgs = buildPushArgs(branch);
    const prArgs = buildPrCreateArgs({ issue, branch, base, draft: opts.draft });
    if (opts.dryRun) {
      console.log("\n[dry-run] would commit, push, and open a PR with:");
      for (const [bin, args] of [["git", buildAddArgs()], ["git", commitArgs], ["git", pushArgs], ["gh", prArgs]] as const) {
        console.log(`  ${formatCommand(bin, args)}`);
      }
      console.log(`\n[dry-run] nothing was pushed; inspect the changes in ${workPath}`);
      return;
    }

    for (const [message, bin, args] of [
      ["failed to stage changes", "git", buildAddArgs()],
      ["failed to commit changes", "git", commitArgs],
      [`failed to push branch "${branch}"`, "git", pushArgs],
    ] as const) {
      const result = run(bin, args, workPath);
      if (result.code !== 0) {
        fail(message, { hint: result.stderr.trim() || undefined });
        return;
      }
    }
    const pr = run("gh", prArgs, workPath);
    if (pr.code !== 0) {
      fail("failed to open the PR via `gh pr create`", { hint: pr.stderr.trim() || undefined });
      return;
    }
    const url = pr.stdout.trim();
    console.log(`\n✓ opened PR for issue #${issue.number}${url ? `: ${url}` : ""}`);
    if (opts.waitCi) {
      const checks = run("gh", buildPrChecksArgs(url || branch), workPath);
      if (checks.code !== 0) {
        console.error("PR checks failed; attempting one bounded repair from failed-step logs.");
        const repaired = await repairFailedCi(projectPath, workPath, branch, opts.maxCost, opts.model);
        if (!repaired || run("gh", buildPrChecksArgs(url || branch), workPath).code !== 0) {
          fail("PR checks failed after the bounded repair attempt", { hint: checks.stderr.trim() || undefined });
          return;
        }
      }
      console.log("✓ PR checks passed");
    }
    removeOnExit = useWorktree;
  } finally {
    process.chdir(originalCwd);
    if (removeOnExit) removeWorktree(projectPath, workPath, true);
  }
}

export async function resolveReviewCommand(prArg: string, opts: ResolveReviewOptions): Promise<void> {
  const projectPath = process.cwd();
  if (!validBudget(opts.maxCost) || !prerequisites(projectPath)) return;
  const view = run("gh", buildPrViewArgs(prArg), projectPath);
  if (view.code !== 0) {
    fail(`failed to fetch PR ${prArg}`, { hint: view.stderr.trim() || undefined });
    return;
  }
  let review: ReviewContext;
  try {
    review = JSON.parse(view.stdout) as ReviewContext;
    if (!Number.isInteger(review.number) || typeof review.title !== "string") throw new Error("invalid PR payload");
  } catch {
    fail("could not parse the `gh pr view` JSON output");
    return;
  }

  const useWorktree = opts.worktree ?? true;
  const workPath = useWorktree ? createTempWorktreePath() : projectPath;
  if (useWorktree) {
    const added = run("git", buildDetachedWorktreeArgs(workPath), projectPath);
    if (added.code !== 0) {
      fail("failed to create an isolated review worktree", { hint: added.stderr.trim() || undefined });
      return;
    }
  }
  const checkout = run("gh", buildPrCheckoutArgs(prArg), workPath);
  if (checkout.code !== 0) {
    if (useWorktree) removeWorktree(projectPath, workPath, true);
    fail(`failed to check out PR ${prArg}`, { hint: checkout.stderr.trim() || undefined });
    return;
  }

  const originalCwd = process.cwd();
  let removeOnExit = false;
  try {
    process.chdir(workPath);
    const completed = await runTaskCommand(buildReviewTaskPrompt(review), {
      mode: "edit",
      permissionMode: "acceptEdits",
      maxCostUsd: opts.maxCost,
      model: opts.model,
    });
    if (!completed || !changed(workPath)) {
      removeOnExit = useWorktree;
      fail(completed ? "the agent made no review changes" : "the review-fix agent run did not complete");
      return;
    }
    if (!verify(projectPath, workPath)) return;
    const commitArgs = buildCommitArgs(`Address review feedback on PR #${review.number}`);
    if (opts.dryRun) {
      console.log("\n[dry-run] would commit and push review fixes with:");
      console.log(`  ${formatCommand("git", buildAddArgs())}`);
      console.log(`  ${formatCommand("git", commitArgs)}`);
      console.log(`  ${formatCommand("git", buildReviewPushArgs())}`);
      console.log(`\n[dry-run] nothing was pushed; inspect the changes in ${workPath}`);
      return;
    }
    for (const args of [buildAddArgs(), commitArgs, buildReviewPushArgs()]) {
      const result = run("git", args, workPath);
      if (result.code !== 0) {
        fail("failed to commit or push review fixes", { hint: result.stderr.trim() || undefined });
        return;
      }
    }
    if (opts.waitCi) {
      const checks = run("gh", buildPrChecksArgs(prArg), workPath);
      if (checks.code !== 0) {
        fail("PR checks failed or could not be completed", { hint: checks.stderr.trim() || undefined });
        return;
      }
    }
    console.log(`\n✓ pushed review fixes for PR #${review.number}`);
    removeOnExit = useWorktree;
  } finally {
    process.chdir(originalCwd);
    if (removeOnExit) removeWorktree(projectPath, workPath, true);
  }
}
