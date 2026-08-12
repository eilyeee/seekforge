/** User-triggered GitHub issue-to-PR and review-fix workflows. */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type BaseConfigShape,
  mergeConfigLayers,
  readJsonConfigLayer,
  repositoryConfigLayer,
} from "@seekforge/shared/config-layers";
import { isAuthorizedDir } from "../authorized-dirs.js";
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
  buildWorktreeListArgs,
  buildWorktreePruneArgs,
  buildWorktreeRemoveArgs,
  buildWorktreeReuseArgs,
  formatCommand,
  isNoChecksReported,
  parseIssueNumber,
  parseWorktreeList,
  staleWorktreesForBranch,
  PR_CHECKS_TIMEOUT_MS,
  type IssueRef,
  type ReviewContext,
} from "../resolve.js";
import { type RunOptions, runTaskCommand } from "./run.js";

export type ResolveOptions = {
  maxCost: number;
  base?: string;
  model?: string;
  draft?: boolean;
  dryRun?: boolean;
  worktree?: boolean;
  waitCi?: boolean;
  /** `-y`: pre-authorize the work directory (required for a not-yet-authorized CI checkout). */
  yes?: boolean;
};

export type ResolveReviewOptions = {
  maxCost: number;
  model?: string;
  dryRun?: boolean;
  worktree?: boolean;
  waitCi?: boolean;
  /** `-y`: pre-authorize the work directory (required for a not-yet-authorized CI checkout). */
  yes?: boolean;
};

/**
 * The options every `resolve` / `resolve-review` agent run uses. These runs are
 * documented as headless, so they must never be able to ask a human anything:
 * a machine output format makes run.ts's confirm auto-DENY instead of prompting
 * (the same lever `schedule run` pulls for its headless ticks), and
 * `suppressResult` keeps that format's result envelope out of resolve's own
 * human output. `acceptEdits` still auto-approves ONLY file edits.
 *
 * `yes` here is folder-access consent for the work directory alone — it can not
 * widen approvals, because `permissionMode` takes precedence over it
 * (see permission-mode.ts).
 */
export function headlessRunOptions(input: { consent: boolean; maxCost: number; model?: string }): RunOptions {
  return {
    mode: "edit",
    permissionMode: "acceptEdits",
    outputFormat: "json",
    suppressResult: true,
    yes: input.consent,
    maxCostUsd: input.maxCost,
    model: input.model,
  };
}

/**
 * Folder-access consent for the work directory. A temporary worktree lives in
 * `$TMPDIR`, outside any authorized ancestor, yet it is a checkout of the very
 * repository the user authorized and explicitly pointed `resolve` at — so that
 * consent carries over. `-y` covers the remaining case (a fresh, not-yet
 * authorized checkout, e.g. in CI), which would otherwise fail hard because a
 * headless run has no prompt to fall back on.
 */
function workspaceConsent(projectPath: string, yes: boolean | undefined): boolean {
  return yes === true || isAuthorizedDir(projectPath);
}

/**
 * Copy the session traces written inside the temporary worktree back into the
 * base repository. `runTaskCommand` records a trace under
 * `<cwd>/.seekforge/sessions/<id>/`, and resolve runs it with the worktree as
 * cwd, so removing the worktree would delete the very trace `seekforge
 * sessions` / `seekforge audit` are documented to inspect afterwards. Each run
 * gets a freshly created worktree, so every session directory in it belongs to
 * this run. An existing destination id is never overwritten.
 */
export function preserveSessionTraces(workPath: string, projectPath: string): void {
  const from = join(workPath, ".seekforge", "sessions");
  const to = join(projectPath, ".seekforge", "sessions");
  let names: string[];
  try {
    // isDirectory() is false for a symlink (readdir uses lstat), so a symlinked
    // session directory is skipped rather than followed.
    names = readdirSync(from, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !existsSync(join(to, entry.name)))
      .map((entry) => entry.name);
  } catch {
    return; // no trace was recorded (the run never started)
  }
  if (names.length === 0) return;
  try {
    mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const name of names) cpSync(join(from, name), join(to, name), { recursive: true });
  } catch (error) {
    console.error(`  could not preserve the session trace: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Project assets a worktree run should see. They are repository-owned text the
 * agent would read in the base checkout anyway, and none of them can carry a
 * credential or grant a capability.
 *
 * `.seekforge/plugins` is deliberately absent: a plugin can contribute a
 * `trusted: true` MCP server and hooks (packages/core/src/plugins/load.ts), so
 * carrying it in would hand the isolated run execution authority the config
 * projection is careful not to give it. `.seekforge/sessions` is absent because
 * it travels the other way (preserveSessionTraces).
 */
const WORKTREE_PROJECT_ASSETS = [
  join(".seekforge", "skills"),
  join(".seekforge", "agents"),
  join(".seekforge", "commands"),
  join(".seekforge", "output-styles"),
  join(".seekforge", "memory", "project.md"),
] as const;

/**
 * Whether git ignores `rel` in this worktree. Classified by EXIT CODE only
 * (0 ignored, 1 not, anything else an error) — no output is parsed, so no
 * locale can change the answer. An error is treated as "not ignored": the
 * conservative direction is to write nothing.
 */
function ignoredInWorktree(workPath: string, rel: string): boolean {
  return run("git", ["check-ignore", "-q", "--", rel], workPath).code === 0;
}

/**
 * Make the base repository's project configuration visible inside the temporary
 * worktree, so an isolated `resolve` run behaves like the same task run in the
 * checkout.
 *
 * It is not visible by default because `.seekforge/` is conventionally
 * gitignored (this repository's own .gitignore does it), and `git worktree add`
 * populates a fresh checkout from the index — so the worktree gets AGENTS.md but
 * no `.seekforge/`. Only the user's `~/.seekforge` layer survives, and the run
 * silently loses the project's model choice, its `deny` permission rules, and
 * its skills/subagents/commands/output-styles/memory.
 *
 * What is carried in, and why that is exactly the right amount:
 *
 *  - The project layer is projected through `sanitizeProjectConfig` — the same
 *    reduction `loadConfig` applies to it in the base checkout. A file written
 *    into `$TMPDIR` can therefore only ever hold what a repository layer is
 *    allowed to assert anyway: bounded enum/scalar preferences and `deny`
 *    permission rules. `apiKey`, `baseUrl`, `verifyCommand`, hooks and every
 *    other user-owned key cannot pass the filter, so the temp directory never
 *    receives a credential — the hazard that makes copying config around a bad
 *    idea in the first place.
 *  - `config.local.json` is projected too. It is personal, but after the same
 *    reduction nothing machine-specific survives, and the run is supposed to
 *    match the checkout.
 *  - `mcpServers` is dropped from the projection. Repository-owned entries are
 *    never `trusted`, so they can never connect in a headless run and would
 *    change nothing — while their `env`/`headers`/`oauth` are precisely the
 *    fields that could put a secret in a temp directory that later gets deleted.
 *
 * Never overwrites: a repository that actually commits `.seekforge/config.json`
 * already has that layer in the worktree, and it wins.
 *
 * Nothing is written unless git IGNORES the destination path in this worktree.
 * `resolve` finishes with `git add -A`, so a seeded file that git can see would
 * be committed and pushed into the pull request — carrying the user's local
 * preferences into someone else's repository. A path git does not ignore is
 * either already tracked (so it is present anyway and needs no seeding) or
 * would end up in the diff; both mean: leave it alone.
 */
export function seedWorktreeProjectLayer(projectPath: string, workPath: string): string[] {
  const carried: string[] = [];
  const target = join(workPath, ".seekforge", "config.json");
  if (!existsSync(target) && ignoredInWorktree(workPath, join(".seekforge", "config.json"))) {
    const layers = [
      join(projectPath, ".seekforge", "config.json"),
      join(projectPath, ".seekforge", "config.local.json"),
    ].map((path) => repositoryConfigLayer(readJsonConfigLayer<BaseConfigShape>(path, { requireObject: true })));
    const projected = mergeConfigLayers(layers, { envOverrides: false }) as Record<string, unknown>;
    delete projected["mcpServers"];
    if (Object.keys(projected).length > 0) {
      try {
        mkdirSync(join(workPath, ".seekforge"), { recursive: true, mode: 0o700 });
        writeFileSync(target, `${JSON.stringify(projected, null, 2)}\n`, { mode: 0o600 });
        carried.push(join(".seekforge", "config.json"));
      } catch (error) {
        console.error(
          `  could not carry the project config into the worktree: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  for (const rel of WORKTREE_PROJECT_ASSETS) {
    const from = join(projectPath, rel);
    const to = join(workPath, rel);
    if (!existsSync(from) || existsSync(to) || !ignoredInWorktree(workPath, rel)) continue;
    try {
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      cpSync(from, to, { recursive: true });
      carried.push(rel);
    } catch (error) {
      console.error(
        `  could not carry ${rel} into the worktree: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return carried;
}

type Result = { code: number; stdout: string; stderr: string; missing: boolean; timedOut: boolean };

function run(bin: string, args: string[], cwd = process.cwd(), timeoutMs?: number): Result {
  const result = spawnSync(bin, args, { cwd, encoding: "utf8", ...(timeoutMs ? { timeout: timeoutMs } : {}) });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { code: 127, stdout: "", stderr: "", missing: true, timedOut: false };
  }
  const timedOut = Boolean(result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT");
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    missing: false,
    timedOut,
  };
}

/**
 * Remove resolve's OWN stale temp worktrees still holding `branch` checked out.
 * A previous failed / `--dry-run` run leaves a temp worktree registered with the
 * issue branch checked out; `git worktree add <path> <branch>` (the reuse path)
 * then fails with "branch already checked out". We prune vanished registrations,
 * then force-remove any lingering seekforge temp worktree for this branch so the
 * reuse can proceed. A user's own worktree of the branch is never touched.
 */
function pruneStaleIssueWorktrees(projectPath: string, branch: string): void {
  run("git", buildWorktreePruneArgs(), projectPath);
  const listed = run("git", buildWorktreeListArgs(), projectPath);
  if (listed.code !== 0) return;
  for (const path of staleWorktreesForBranch(parseWorktreeList(listed.stdout), branch)) {
    removeWorktree(projectPath, path, true);
  }
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
  for (const [label, command] of [
    ["verify", config.verifyCommand],
    ["lint", config.lintCommand],
  ] as const) {
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
  consent: boolean,
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
  const completed = await runTaskCommand(
    buildCiRepairPrompt(logs.stdout),
    headlessRunOptions({ consent, maxCost, model }),
  );
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
  const consent = workspaceConsent(projectPath, opts.yes);
  const useWorktree = opts.worktree ?? true;
  const workPath = useWorktree ? createTempWorktreePath() : projectPath;
  const reuseBranch = existingBranch(projectPath, branch);
  // A retained temp worktree from a prior failed/dry run keeps this branch
  // checked out, which blocks the reuse `git worktree add`. Clear our own stale
  // worktrees for the branch first (SCH4).
  if (useWorktree && reuseBranch) pruneStaleIssueWorktrees(projectPath, branch);
  const branchResult = useWorktree
    ? run(
        "git",
        reuseBranch ? buildWorktreeReuseArgs(workPath, branch) : buildWorktreeAddArgs(workPath, branch, base),
        projectPath,
      )
    : run("git", reuseBranch ? ["checkout", branch] : buildBranchArgs(branch), projectPath);
  if (branchResult.code !== 0) {
    fail(`failed to create work branch "${branch}"`, { hint: branchResult.stderr.trim() || undefined });
    return;
  }

  console.log(`▶ resolving issue #${issue.number}: ${issue.title}`);
  if (useWorktree) {
    console.log(`  isolated worktree: ${workPath}`);
    const carried = seedWorktreeProjectLayer(projectPath, workPath);
    if (carried.length > 0) console.log(`  project configuration carried in: ${carried.join(", ")}`);
  }
  let removeOnExit = false;
  const originalCwd = process.cwd();
  try {
    process.chdir(workPath);
    const completed = await runTaskCommand(
      buildTaskPrompt(issue),
      headlessRunOptions({ consent, maxCost: opts.maxCost, model: opts.model }),
    );
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
      for (const [bin, args] of [
        ["git", buildAddArgs()],
        ["git", commitArgs],
        ["git", pushArgs],
        ["gh", prArgs],
      ] as const) {
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
      const checks = run("gh", buildPrChecksArgs(url || branch), workPath, PR_CHECKS_TIMEOUT_MS);
      if (checks.timedOut) {
        console.log(
          `\n⚠ timed out after ${PR_CHECKS_TIMEOUT_MS / 60_000}m waiting for PR checks; the PR is already open.`,
        );
        console.log(`  inspect its checks with: gh pr checks ${url || branch}`);
      } else if (checks.code !== 0 && isNoChecksReported(`${checks.stdout}\n${checks.stderr}`)) {
        // No checks configured is NOT a failure — do not enter CI repair.
        console.log("\n✓ PR opened; no CI checks are configured for this PR.");
      } else if (checks.code !== 0) {
        console.error("PR checks failed; attempting one bounded repair from failed-step logs.");
        const repaired = await repairFailedCi(projectPath, workPath, branch, opts.maxCost, opts.model, consent);
        const recheck = repaired
          ? run("gh", buildPrChecksArgs(url || branch), workPath, PR_CHECKS_TIMEOUT_MS)
          : undefined;
        if (!repaired || recheck!.timedOut || recheck!.code !== 0) {
          fail("PR checks failed after the bounded repair attempt", { hint: checks.stderr.trim() || undefined });
          return;
        }
        console.log("✓ PR checks passed");
      } else {
        console.log("✓ PR checks passed");
      }
    }
    removeOnExit = useWorktree;
  } finally {
    process.chdir(originalCwd);
    // Before the worktree can be removed: the run's trace must survive it, or
    // the documented `seekforge sessions|audit` follow-up has nothing to read.
    if (useWorktree) preserveSessionTraces(workPath, projectPath);
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
  // Same code path, same defect: without this the review-fix run sees only
  // ~/.seekforge and loses the project's model, deny rules and skills.
  if (useWorktree) {
    const carried = seedWorktreeProjectLayer(projectPath, workPath);
    if (carried.length > 0) console.log(`  project configuration carried in: ${carried.join(", ")}`);
  }

  const originalCwd = process.cwd();
  let removeOnExit = false;
  try {
    process.chdir(workPath);
    const completed = await runTaskCommand(
      buildReviewTaskPrompt(review),
      headlessRunOptions({
        consent: workspaceConsent(projectPath, opts.yes),
        maxCost: opts.maxCost,
        model: opts.model,
      }),
    );
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
      const checks = run("gh", buildPrChecksArgs(prArg), workPath, PR_CHECKS_TIMEOUT_MS);
      if (checks.timedOut) {
        console.log(
          `\n⚠ timed out after ${PR_CHECKS_TIMEOUT_MS / 60_000}m waiting for PR checks; review fixes are pushed.`,
        );
      } else if (checks.code !== 0 && !isNoChecksReported(`${checks.stdout}\n${checks.stderr}`)) {
        fail("PR checks failed or could not be completed", { hint: checks.stderr.trim() || undefined });
        return;
      }
    }
    console.log(`\n✓ pushed review fixes for PR #${review.number}`);
    removeOnExit = useWorktree;
  } finally {
    process.chdir(originalCwd);
    if (useWorktree) preserveSessionTraces(workPath, projectPath);
    if (removeOnExit) removeWorktree(projectPath, workPath, true);
  }
}
