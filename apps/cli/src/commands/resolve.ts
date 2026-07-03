/**
 * `seekforge resolve <issue>` — the autonomous GitHub issue→PR resolver.
 *
 * Flow (all argv comes from the PURE builders in `../resolve.js`):
 *   1. Fetch the issue read-only:   gh issue view <n> --json title,body,number
 *   2. Create a work branch:        git checkout -b seekforge/issue-<n>
 *   3. Run the agent HEADLESS to fix it (reuses runTaskCommand, mode edit,
 *      acceptEdits, the REQUIRED --max-cost budget enforced).
 *   4. Run the configured verify/lint command; abort the PR if it fails.
 *   5. Commit + push + open a PR:    git add -A / git commit / git push /
 *                                    gh pr create --draft --base … --head …
 *   6. Print the PR URL.
 *
 * `--dry-run` does 1–4 (fetch + branch + fix + verify) then PRINTS the exact
 * commit/push/PR commands it WOULD run, without pushing or opening a PR.
 *
 * MOAT: the AGENT never pushes. Steps 5–6 are performed by THIS command — the
 * user's explicit `resolve` invocation — not by the agent, so the push-approval
 * gate stays intact.
 */

import { spawnSync } from "node:child_process";
import { fail } from "../colors.js";
import { loadConfig } from "../config.js";
import {
  InvalidIssueError,
  buildAddArgs,
  buildBranchArgs,
  buildBranchName,
  buildCommitArgs,
  buildCommitMessage,
  buildIssueViewArgs,
  buildPrCreateArgs,
  buildPushArgs,
  buildTaskPrompt,
  formatCommand,
  parseIssueNumber,
  type IssueRef,
} from "../resolve.js";
import { runTaskCommand } from "./run.js";

export type ResolveOptions = {
  /** REQUIRED per-run cost cap in USD (an autonomous fix must be bounded). */
  maxCost: number;
  /** Base branch to open the PR against (default: main). */
  base?: string;
  /** Model override for the headless fix run. */
  model?: string;
  /** Open a real (non-draft) PR. commander sets this false for --no-draft. */
  draft?: boolean;
  /** Do the fetch + branch + fix + verify, but print (don't run) push/PR. */
  dryRun?: boolean;
};

/** Run a binary synchronously, capturing stdout/stderr. */
function run(bin: string, args: string[]): { code: number; stdout: string; stderr: string; missing: boolean } {
  const r = spawnSync(bin, args, { encoding: "utf8" });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { code: 127, stdout: "", stderr: "", missing: true };
  }
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", missing: false };
}

/** True if `gh` is on PATH. */
function ghAvailable(): boolean {
  return !run("gh", ["--version"]).missing;
}

/** The `origin` remote URL, or undefined if the repo has no origin. */
function originRemote(): string | undefined {
  const r = run("git", ["remote", "get-url", "origin"]);
  if (r.missing || r.code !== 0) return undefined;
  const url = r.stdout.trim();
  return url === "" ? undefined : url;
}

export async function resolveCommand(issueArg: string, opts: ResolveOptions): Promise<void> {
  const projectPath = process.cwd();

  // --max-cost is REQUIRED (an autonomous run must be bounded). commander marks
  // it required too; this guards direct/programmatic callers.
  if (typeof opts.maxCost !== "number" || !Number.isFinite(opts.maxCost) || opts.maxCost <= 0) {
    fail("--max-cost <usd> is required (an autonomous fix must be cost-bounded)", {
      hint: "e.g. seekforge resolve 42 --max-cost 1.00",
    });
    return;
  }

  // Parse the issue number from a number or a GitHub issue URL.
  let issueNumber: number;
  try {
    issueNumber = parseIssueNumber(issueArg);
  } catch (err) {
    if (err instanceof InvalidIssueError) {
      fail(err.message);
      return;
    }
    throw err;
  }

  // Prerequisites: gh authed + on PATH, and the repo has an origin remote.
  if (!ghAvailable()) {
    fail("the GitHub CLI (`gh`) was not found on PATH", {
      hint: "install it from https://cli.github.com and run `gh auth login`",
    });
    return;
  }
  if (originRemote() === undefined) {
    fail("this repository has no `origin` remote", {
      hint: "add one with: git remote add origin <url>",
    });
    return;
  }

  // 1. Fetch the issue (read-only).
  const view = run("gh", buildIssueViewArgs(issueNumber));
  if (view.code !== 0) {
    fail(`failed to fetch issue #${issueNumber} via \`gh issue view\``, {
      hint: view.stderr.trim() || "is `gh` authenticated for this repo? try `gh auth status`",
    });
    return;
  }
  let issue: IssueRef;
  try {
    const parsed = JSON.parse(view.stdout) as { number?: number; title?: string; body?: string };
    issue = {
      number: parsed.number ?? issueNumber,
      title: parsed.title ?? "",
      body: parsed.body ?? "",
    };
  } catch {
    fail("could not parse the `gh issue view` JSON output");
    return;
  }
  console.log(`▶ resolving issue #${issue.number}: ${issue.title}`);

  const config = loadConfig(projectPath);
  const branch = buildBranchName(issue.number);

  // 2. Create the work branch.
  const branchResult = run("git", buildBranchArgs(branch));
  if (branchResult.code !== 0) {
    fail(`failed to create work branch "${branch}"`, {
      hint: branchResult.stderr.trim() || "does the branch already exist? delete it or check out a clean base first",
    });
    return;
  }
  console.log(`  created branch ${branch}`);

  // 3. Run the agent HEADLESS to fix the issue (edit mode, acceptEdits, budget).
  console.log("  running the agent to fix the issue…\n");
  await runTaskCommand(buildTaskPrompt(issue), {
    mode: "edit",
    permissionMode: "acceptEdits",
    maxCostUsd: opts.maxCost,
    model: opts.model,
  });

  // Nothing changed? There is nothing to commit / PR.
  const status = run("git", ["status", "--porcelain"]);
  if (status.code === 0 && status.stdout.trim() === "") {
    fail("the agent made no changes — nothing to commit or open a PR for", {
      hint: `inspect the run, then remove the empty branch: git checkout - && git branch -D ${branch}`,
    });
    return;
  }

  // 4. Verify/lint gate: abort the PR if a configured command fails.
  for (const [label, cmd] of [
    ["verify", config.verifyCommand],
    ["lint", config.lintCommand],
  ] as const) {
    if (!cmd || cmd.trim() === "") continue;
    console.log(`\n  running ${label} command: ${cmd}`);
    const r = spawnSync(cmd, { shell: true, stdio: "inherit" });
    if ((r.status ?? 1) !== 0) {
      fail(`${label} command failed — not opening a PR`, {
        hint: `fix the failures on branch "${branch}", then re-run or open the PR manually`,
      });
      return;
    }
  }

  const commitMessage = buildCommitMessage(issue);
  const pushArgs = buildPushArgs(branch);
  const prArgs = buildPrCreateArgs({ issue, branch, base: opts.base, draft: opts.draft });

  // --dry-run: print what WOULD be pushed / PR'd, and stop (no push, no PR).
  if (opts.dryRun) {
    console.log("\n[dry-run] would commit, push, and open a PR with:");
    console.log(`  ${formatCommand("git", buildAddArgs())}`);
    console.log(`  ${formatCommand("git", buildCommitArgs(commitMessage))}`);
    console.log(`  ${formatCommand("git", pushArgs)}`);
    console.log(`  ${formatCommand("gh", prArgs)}`);
    console.log(`\n[dry-run] the fix is on branch "${branch}"; nothing was pushed.`);
    return;
  }

  // 5. Commit + push + open the PR (the USER's explicit action — not the agent).
  const add = run("git", buildAddArgs());
  if (add.code !== 0) {
    fail("failed to stage changes (git add -A)", { hint: add.stderr.trim() || undefined });
    return;
  }
  const commit = run("git", buildCommitArgs(commitMessage));
  if (commit.code !== 0) {
    fail("failed to commit changes", { hint: commit.stderr.trim() || undefined });
    return;
  }
  const push = run("git", pushArgs);
  if (push.code !== 0) {
    fail(`failed to push branch "${branch}"`, {
      hint: push.stderr.trim() || "check your push permissions and `git remote -v`",
    });
    return;
  }
  const pr = run("gh", prArgs);
  if (pr.code !== 0) {
    fail("failed to open the PR via `gh pr create`", {
      hint: pr.stderr.trim() || "the branch was pushed — you can open the PR manually",
    });
    return;
  }

  // 6. Print the PR URL (gh pr create prints it on stdout).
  const url = pr.stdout.trim();
  console.log(`\n✓ opened PR for issue #${issue.number}${url ? `: ${url}` : ""}`);
}
