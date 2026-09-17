/**
 * Source-control routes: /api/diff, /api/git/status, stage/unstage/discard,
 * per-hunk stage/unstage/revert, /api/git/commit, push, and `gh pr create`,
 * plus the git exec helpers they share.
 */

import { execFile, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";
import { promisify } from "node:util";
import { acquireWorkspaceSessionGuard, onAbortOnce, SessionBusyError } from "@seekforge/core";
import { readJsonBody, requestAbortSignal, sendApiError, sendJson } from "../http.js";
import type { RouteCtx } from "./context.js";

const execFileAsync = promisify(execFile);

/** Locale-stable Git execution; classification still uses exit codes/probes. */
const GIT_EXEC = (cwd: string): { cwd: string; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv } => ({
  cwd,
  timeout: 30_000,
  maxBuffer: 10_000_000,
  env: { ...process.env, LC_ALL: "C", LANG: "C" },
});

type ProcessResult = { code: number; stdout: string; stderr: string; timedOut: boolean; aborted: boolean };

const MAX_PROCESS_OUTPUT_CHARS = 10_000_000;

/**
 * Runs a process to completion and reports how it ended. It rejects only when
 * the binary cannot be started (ENOENT and friends), so callers can tell
 * "git/gh is missing" apart from a clean non-zero exit. An aborted `signal`
 * (the HTTP client went away, or the server is closing) ends the process, so a
 * long network operation cannot keep holding the repository lock.
 */
function runProcess(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; input?: string; signal?: AbortSignal },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({ code: -1, stdout: "", stderr: "", timedOut: false, aborted: true });
      return;
    }
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    const offAbort = onAbortOnce(opts.signal, () => {
      aborted = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
    });
    const finish = (): void => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      offAbort();
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_PROCESS_OUTPUT_CHARS) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_PROCESS_OUTPUT_CHARS) stderr += chunk;
    });
    child.stdin.on("error", () => {});
    child.once("error", (error) => {
      finish();
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code) => {
      finish();
      if (settled) return;
      settled = true;
      resolve({ code: code ?? -1, stdout, stderr, timedOut, aborted });
    });
    child.stdin.end(opts.input ?? "");
  });
}

/** Locale-stable git that never waits on a credential prompt. */
const GIT_PROCESS_ENV = (): NodeJS.ProcessEnv => ({
  ...process.env,
  LC_ALL: "C",
  LANG: "C",
  GIT_TERMINAL_PROMPT: "0",
});

function runGit(
  workspace: string,
  args: string[],
  input?: string,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return runProcess("git", args, {
    cwd: workspace,
    env: GIT_PROCESS_ENV(),
    timeoutMs,
    ...(input !== undefined ? { input } : {}),
    ...(signal ? { signal } : {}),
  });
}

/**
 * `git diff` as every diff route renders it. Pinned against user config that
 * would change its shape: colors, external diff drivers, custom prefixes and
 * context size — the hunk route matches on this exact text.
 */
const DIFF_ARGS = [
  "-c",
  "core.quotepath=false",
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--unified=3",
] as const;

async function isGitRepository(workspace: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--git-dir"], GIT_EXEC(workspace));
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || typeof code !== "number") throw error;
    return false;
  }
}

/** Current git diff of the workspace (no shell; capped at 2 MB). */
async function gitDiff(
  workspace: string,
  staged: boolean,
): Promise<{ diff: string; truncated: boolean; notGit?: boolean }> {
  // core.quotepath=false: emit non-ASCII paths verbatim (UTF-8) rather than
  // octal-escaped and double-quoted, matching the discard endpoint's probe.
  const args = [...DIFF_ARGS, ...(staged ? ["--cached"] : [])];
  const MAX = 2_000_000;
  try {
    const { stdout } = await execFileAsync("git", args, GIT_EXEC(workspace));
    return stdout.length > MAX ? { diff: stdout.slice(0, MAX), truncated: true } : { diff: stdout, truncated: false };
  } catch (err) {
    const e = err as { stderr?: string; message?: string; code?: string; stdout?: string };
    const stderr = e.stderr ?? e.message ?? "";
    // A workspace that isn't a git repo is a normal, expected state (e.g. the
    // desktop hosting a plain folder) — report it as an empty, non-error result
    // so the UI shows a friendly "not a git repository" notice, not a red error.
    // (Git missing entirely, "spawn git ENOENT", stays a real error so the user
    // learns git isn't installed rather than seeing a misleading empty diff.)
    if (!(await isGitRepository(workspace))) {
      return { diff: "", truncated: false, notGit: true };
    }
    // A diff bigger than execFile's maxBuffer rejects before it can resolve;
    // Node still hands us the captured prefix on err.stdout. Treat that exactly
    // like the >MAX case above so a huge diff returns a truncated result rather
    // than a misleading 500 (the buffer overflow can never reach the >MAX slice
    // on the success path, so without this it was unrecoverable).
    if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/i.test(e.message ?? "")) {
      const captured = typeof e.stdout === "string" ? e.stdout : "";
      return { diff: captured.slice(0, MAX), truncated: true };
    }
    throw new Error(`git diff failed: ${stderr.slice(0, 500)}`);
  }
}

type GitFileStatus = {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  staged: boolean;
};

type GitStatusResult = {
  notGit?: boolean;
  branch: string;
  files: GitFileStatus[];
};

const LITERAL_PATHSPECS = "--literal-pathspecs";

/** Maps a single porcelain status code letter to our coarse status enum. */
function mapStatusCode(code: string): GitFileStatus["status"] {
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    default:
      // "M", "T", "U" and anything else collapse to "modified".
      return "modified";
  }
}

/**
 * Working-tree status of the workspace via `git status --porcelain=v1 -z -b`.
 * A non-repo (or git missing) is reported as {notGit:true, branch:"", files:[]}
 * — never thrown — mirroring gitDiff's notGit handling.
 */
async function gitStatus(workspace: string): Promise<GitStatusResult> {
  let stdout: string;
  try {
    // core.quotepath=false: keep non-ASCII paths as raw UTF-8 so the names the
    // UI sends back to stage/unstage/discard match the real files (git's
    // default octal-escapes them, breaking those mutations for e.g. CJK names).
    ({ stdout } = await execFileAsync(
      "git",
      ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "-b"],
      GIT_EXEC(workspace),
    ));
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const stderr = e.stderr ?? e.message ?? "";
    if (!(await isGitRepository(workspace))) {
      return { notGit: true, branch: "", files: [] };
    }
    throw new Error(`git status failed: ${stderr.slice(0, 500)}`);
  }
  let branch = "";
  const files: GitFileStatus[] = [];
  const records = stdout.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i] as string;
    if (record === "") continue;
    if (record.startsWith("## ")) {
      // "## main...origin/main [ahead 1]", "## HEAD (no branch)", or (on a repo
      // with no commits yet) "## No commits yet on main".
      const rest = record.slice(3);
      const unborn = /^No commits yet on (.+)$/.exec(rest);
      branch = unborn ? (unborn[1] as string) : (rest.split(/\.\.\.| /)[0] ?? "");
      continue;
    }
    const x = record[0] ?? " ";
    const y = record[1] ?? " ";
    const pathPart = record.slice(3);
    // In -z mode rename/copy records contain destination first, then a second
    // NUL-terminated source path. The source is not a status record.
    if (x === "R" || x === "C" || y === "R" || y === "C") i++;
    if (x === "?" && y === "?") {
      files.push({ path: pathPart, status: "untracked", staged: false });
      continue;
    }
    // A path can be both staged (index, X) and unstaged (worktree, Y); emit
    // one entry per side so the UI can show staged/unstaged separately.
    if (x !== " " && x !== "?") {
      files.push({ path: pathPart, status: mapStatusCode(x), staged: true });
    }
    if (y !== " " && y !== "?") {
      files.push({ path: pathPart, status: mapStatusCode(y), staged: false });
    }
  }
  return { branch, files };
}

/** One file's diff split at its hunks; null unless the text holds exactly one file. */
export function splitFilePatch(diff: string): { header: string[]; hunks: string[] } | null {
  const lines = diff.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.filter((line) => line.startsWith("diff --git ")).length !== 1) return null;
  const header: string[] = [];
  const hunks: string[][] = [];
  for (const line of lines) {
    if (line.startsWith("@@ ")) hunks.push([line]);
    else if (hunks.length > 0) hunks[hunks.length - 1]!.push(line);
    else header.push(line);
  }
  return { header, hunks: hunks.map((hunk) => hunk.join("\n")) };
}

function trimTrailingNewlines(text: string): string {
  return text.replace(/\n+$/, "");
}

type HunkAction = "stage" | "unstage" | "revert";

/** The index form of `git apply` each action needs, applied to one hunk. */
const HUNK_APPLY_ARGS: Record<HunkAction, string[]> = {
  stage: ["apply", "--cached", "--whitespace=nowarn", "-"],
  unstage: ["apply", "--cached", "-R", "--whitespace=nowarn", "-"],
  revert: ["apply", "-R", "--whitespace=nowarn", "-"],
};

type RemoteInfo = {
  notGit?: true;
  /** Checked-out branch; null when HEAD is detached. */
  branch: string | null;
  remotes: string[];
  upstream: { remote: string; branch: string } | null;
  ahead: number | null;
  behind: number | null;
  gh: { available: boolean };
};

async function ghAvailable(workspace: string): Promise<boolean> {
  try {
    const result = await runProcess("gh", ["--version"], { cwd: workspace, env: GH_ENV(), timeoutMs: 10_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function currentBranch(workspace: string): Promise<string | null> {
  const result = await runGit(workspace, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (result.code === 0) return result.stdout.trim();
  // Exit 1 is git's documented "HEAD is not a symbolic ref" (detached).
  if (result.code === 1) return null;
  throw new Error(`git symbolic-ref failed: ${result.stderr.slice(0, 500)}`);
}

async function remoteNames(workspace: string): Promise<string[]> {
  const result = await runGit(workspace, ["remote"]);
  if (result.code !== 0) throw new Error(`git remote failed: ${result.stderr.slice(0, 500)}`);
  return result.stdout
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
}

async function upstreamOf(
  workspace: string,
  branch: string,
  remotes: readonly string[],
): Promise<{ remote: string; branch: string } | null> {
  const remote = (await runGit(workspace, ["config", "--get", `branch.${branch}.remote`])).stdout.trim();
  const merge = (await runGit(workspace, ["config", "--get", `branch.${branch}.merge`])).stdout.trim();
  if (!remotes.includes(remote) || !merge.startsWith("refs/heads/")) return null;
  return { remote, branch: merge.slice("refs/heads/".length) };
}

async function remoteInfo(workspace: string): Promise<RemoteInfo> {
  if (!(await isGitRepository(workspace))) {
    return {
      notGit: true,
      branch: null,
      remotes: [],
      upstream: null,
      ahead: null,
      behind: null,
      gh: { available: false },
    };
  }
  const [branch, remotes, gh] = await Promise.all([
    currentBranch(workspace),
    remoteNames(workspace),
    ghAvailable(workspace),
  ]);
  const upstream = branch === null ? null : await upstreamOf(workspace, branch, remotes);
  let ahead: number | null = null;
  let behind: number | null = null;
  if (upstream) {
    const counts = await runGit(workspace, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
    const match = /^(\d+)\s+(\d+)/.exec(counts.stdout.trim());
    if (counts.code === 0 && match) {
      behind = Number(match[1]);
      ahead = Number(match[2]);
    }
  }
  return { branch, remotes, upstream, ahead, behind, gh: { available: gh } };
}

/** gh without prompts, update checks, or color codes in what we relay. */
const GH_ENV = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  NO_COLOR: "1",
  CLICOLOR: "0",
  GIT_TERMINAL_PROMPT: "0",
});

const BRANCH_ARG_RE = /^[A-Za-z0-9._/-]{1,255}$/;

function clipOutput(result: ProcessResult): string {
  return `${result.stdout}${result.stderr}`.trim().slice(0, 8_000);
}

export async function handle(ctx: RouteCtx): Promise<boolean> {
  await routes(ctx);
  return ctx.res.headersSent;
}

async function runGitMutation(ctx: RouteCtx, operation: () => Promise<void>): Promise<void> {
  try {
    await ctx.rest.coordinator.withRepository(ctx.workspace, async () => {
      const guard = acquireWorkspaceSessionGuard(ctx.workspace);
      try {
        await operation();
      } finally {
        guard.release();
      }
    });
  } catch (error) {
    if (!(error instanceof SessionBusyError)) throw error;
    sendApiError(ctx.res, 409, "session_busy", "cannot modify Git state while the workspace has an active session");
  }
}

async function routes(ctx: RouteCtx): Promise<void> {
  const { req, res, url, method, segs, workspace } = ctx;
  const path = url.pathname;

  if (method === "GET" && path === "/api/diff") {
    const staged = url.searchParams.get("staged") === "1";
    return sendJson(res, 200, await gitDiff(workspace, staged));
  }

  // Source control (git). A non-repo is a normal state ({notGit:true}).
  if (method === "GET" && path === "/api/git/status") {
    return sendJson(res, 200, await gitStatus(workspace));
  }

  if (
    method === "POST" &&
    segs.length === 3 &&
    segs[1] === "git" &&
    (segs[2] === "stage" || segs[2] === "unstage" || segs[2] === "discard")
  ) {
    const action = segs[2]!;
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { paths } = (body ?? {}) as { paths?: unknown };
    if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string" && p !== "")) {
      return sendApiError(res, 400, "bad_request", "body must be {paths: non-empty string[]}");
    }
    const relPaths = paths as string[];
    return runGitMutation(ctx, async () => {
      try {
        if (action === "stage") {
          await execFileAsync("git", [LITERAL_PATHSPECS, "add", "--", ...relPaths], GIT_EXEC(workspace));
        } else if (action === "unstage") {
          await execFileAsync(
            "git",
            [LITERAL_PATHSPECS, "restore", "--staged", "--", ...relPaths],
            GIT_EXEC(workspace),
          );
        } else {
          // discard: tracked changes via `git restore`; untracked files removed.
          // Determine which of the given paths are untracked, then handle both.
          const { stdout } = await execFileAsync(
            "git",
            [LITERAL_PATHSPECS, "-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--", ...relPaths],
            GIT_EXEC(workspace),
          );
          const untracked = new Set<string>();
          for (const record of stdout.split("\0")) {
            if (record.startsWith("?? ")) untracked.add(record.slice(3));
          }
          const tracked = relPaths.filter((p) => !untracked.has(p));
          if (tracked.length > 0) {
            await execFileAsync("git", [LITERAL_PATHSPECS, "restore", "--", ...tracked], GIT_EXEC(workspace));
          }
          for (const p of relPaths) {
            if (!untracked.has(p)) continue;
            const resolved = resolvePath(workspace, p);
            const wsResolved = resolvePath(workspace);
            if (resolved === wsResolved || !resolved.startsWith(wsResolved + sep)) {
              sendApiError(res, 400, "bad_request", `path escapes the workspace: ${p}`);
              return;
            }
            rmSync(resolved, { force: true, recursive: true });
          }
        }
        sendJson(res, 200, { ok: true });
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        const stderr = e.stderr ?? e.message ?? "";
        sendApiError(res, 400, "bad_request", `git ${action} failed: ${stderr.slice(0, 500)}`);
      }
    });
  }

  // Stage, unstage, or revert exactly one hunk. The client names the hunk by
  // its text as /api/diff printed it; the server recomputes the file's diff
  // under the repository/workspace guard and applies its OWN copy only when
  // the two still match, so a stale view can never apply a different change.
  if (method === "POST" && path === "/api/git/hunk") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { path: filePath, hunk, action } = (body ?? {}) as { path?: unknown; hunk?: unknown; action?: unknown };
    if (typeof filePath !== "string" || filePath === "" || filePath.length > 4_096 || filePath.includes("\0")) {
      return sendApiError(res, 400, "bad_request", "path must be a workspace-relative file path");
    }
    if (typeof hunk !== "string" || !hunk.startsWith("@@ ") || hunk.length > 2_000_000) {
      return sendApiError(res, 400, "bad_request", "hunk must be one hunk of the current diff, starting with @@");
    }
    if (action !== "stage" && action !== "unstage" && action !== "revert") {
      return sendApiError(res, 400, "bad_request", 'action must be "stage", "unstage" or "revert"');
    }
    return runGitMutation(ctx, async () => {
      if (!(await isGitRepository(workspace))) {
        sendApiError(res, 400, "not_a_git_repo", "not a git repository");
        return;
      }
      const diff = await runGit(workspace, [
        LITERAL_PATHSPECS,
        ...DIFF_ARGS,
        ...(action === "unstage" ? ["--cached"] : []),
        "--",
        filePath,
      ]);
      if (diff.code !== 0) {
        sendApiError(res, 400, "git_error", `git diff failed: ${diff.stderr.slice(0, 500)}`);
        return;
      }
      const file = splitFilePatch(diff.stdout);
      const wanted = trimTrailingNewlines(hunk);
      const current = file?.hunks.find((candidate) => trimTrailingNewlines(candidate) === wanted);
      if (!file || current === undefined) {
        sendApiError(res, 409, "conflict", "that change is no longer in the diff; refresh and try again");
        return;
      }
      const patch = `${[...file.header, trimTrailingNewlines(current)].join("\n")}\n`;
      const applied = await runGit(workspace, HUNK_APPLY_ARGS[action], patch);
      if (applied.code !== 0) {
        sendApiError(res, 409, "conflict", `git apply failed: ${applied.stderr.slice(0, 500)}`);
        return;
      }
      sendJson(res, 200, { ok: true });
    });
  }

  // Branch, remotes, upstream and ahead/behind for the push dialog, plus
  // whether the GitHub CLI is reachable for "Create PR".
  if (method === "GET" && path === "/api/git/remote") {
    return sendJson(res, 200, await remoteInfo(workspace));
  }

  // Push the checked-out branch. Never forced: there is no force option, and
  // the refspec is always `refs/heads/<branch>:refs/heads/<dest>`, which
  // cannot carry git's leading `+`. The client must name the branch it showed
  // the user; a branch switch in between is a 409, not a push of something else.
  if (method === "POST" && path === "/api/git/push") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { remote, branch, setUpstream } = (body ?? {}) as {
      remote?: unknown;
      branch?: unknown;
      setUpstream?: unknown;
    };
    if (typeof remote !== "string" || remote === "" || typeof branch !== "string" || branch === "") {
      return sendApiError(res, 400, "bad_request", "body must be {remote, branch, setUpstream?}");
    }
    if (setUpstream !== undefined && typeof setUpstream !== "boolean") {
      return sendApiError(res, 400, "bad_request", "setUpstream must be a boolean when present");
    }
    const operation = requestAbortSignal(req, res);
    try {
      await ctx.rest.coordinator.withRepository(workspace, async () => {
        // A client that left while the push waited for the lock gets no push.
        if (operation.signal.aborted) return;
        if (!(await isGitRepository(workspace))) {
          sendApiError(res, 400, "not_a_git_repo", "not a git repository");
          return;
        }
        const checkedOut = await currentBranch(workspace);
        if (checkedOut !== branch) {
          sendApiError(
            res,
            409,
            "conflict",
            `the checked-out branch is ${checkedOut ?? "(detached HEAD)"}, not ${branch}`,
          );
          return;
        }
        const remotes = await remoteNames(workspace);
        if (!remotes.includes(remote)) {
          sendApiError(res, 400, "bad_request", `unknown remote: ${remote}`);
          return;
        }
        const upstream = await upstreamOf(workspace, branch, remotes);
        const destination = upstream && upstream.remote === remote ? upstream.branch : branch;
        const result = await runGit(
          workspace,
          [
            "push",
            "--porcelain",
            ...(setUpstream === true ? ["--set-upstream"] : []),
            "--",
            remote,
            `refs/heads/${branch}:refs/heads/${destination}`,
          ],
          undefined,
          120_000,
          operation.signal,
        );
        if (result.aborted) return;
        if (result.code === 0) {
          sendJson(res, 200, { ok: true, remote, branch, destination, output: clipOutput(result) });
          return;
        }
        // --porcelain marks a refused ref with a leading "!" — a stable,
        // untranslated flag, unlike the human message around it.
        const rejected = result.stdout.split("\n").some((line) => line.startsWith("!\t"));
        const reason = result.timedOut ? "git push timed out" : "git push failed";
        sendApiError(
          res,
          rejected ? 409 : 400,
          rejected ? "conflict" : "git_error",
          `${reason}: ${clipOutput(result)}`,
        );
      });
    } finally {
      operation.cleanup();
    }
    return;
  }

  // Open a pull request for the checked-out branch with the GitHub CLI.
  if (method === "POST" && path === "/api/git/pr") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const {
      title,
      body: prBody,
      draft,
      base,
    } = (body ?? {}) as {
      title?: unknown;
      body?: unknown;
      draft?: unknown;
      base?: unknown;
    };
    if (typeof title !== "string" || title.trim() === "" || title.length > 256 || /[\r\n]/.test(title)) {
      return sendApiError(res, 400, "bad_request", "title must be a single line of 1-256 characters");
    }
    if (prBody !== undefined && (typeof prBody !== "string" || prBody.length > 65_536)) {
      return sendApiError(res, 400, "bad_request", "body must be a string of at most 65536 characters");
    }
    if (draft !== undefined && typeof draft !== "boolean") {
      return sendApiError(res, 400, "bad_request", "draft must be a boolean when present");
    }
    if (base !== undefined && (typeof base !== "string" || !BRANCH_ARG_RE.test(base) || base.startsWith("-"))) {
      return sendApiError(res, 400, "bad_request", "base must be a branch name");
    }
    let result: ProcessResult;
    const operation = requestAbortSignal(req, res);
    try {
      // `--flag=value` keeps a title or body that starts with "-" a value.
      result = await runProcess(
        "gh",
        [
          "pr",
          "create",
          `--title=${title.trim()}`,
          `--body=${typeof prBody === "string" ? prBody : ""}`,
          ...(draft === true ? ["--draft"] : []),
          ...(typeof base === "string" ? [`--base=${base}`] : []),
        ],
        { cwd: workspace, env: GH_ENV(), timeoutMs: 120_000, signal: operation.signal },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return sendApiError(res, 400, "bad_request", "the GitHub CLI (gh) is not installed or not on PATH");
      }
      throw error;
    } finally {
      operation.cleanup();
    }
    if (result.aborted) return;
    if (result.code !== 0) {
      const reason = result.timedOut ? "gh pr create timed out" : "gh pr create failed";
      return sendApiError(res, 400, "bad_request", `${reason}: ${clipOutput(result)}`);
    }
    const url = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .reverse()
      .find((line) => /^https?:\/\//.test(line));
    return sendJson(res, 200, { ok: true, url: url ?? null, output: clipOutput(result) });
  }

  if (method === "POST" && path === "/api/git/commit") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { message: msg } = (body ?? {}) as { message?: unknown };
    if (typeof msg !== "string" || msg.trim() === "") {
      return sendApiError(res, 400, "bad_request", "commit message must be a non-empty string");
    }
    return runGitMutation(ctx, async () => {
      const status = await gitStatus(workspace);
      if (status.notGit) {
        sendApiError(res, 400, "bad_request", "not a git repository");
        return;
      }
      if (!status.files.some((f) => f.staged)) {
        sendApiError(res, 400, "bad_request", "nothing staged to commit");
        return;
      }
      try {
        await execFileAsync("git", ["commit", "-m", msg], GIT_EXEC(workspace));
        const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], GIT_EXEC(workspace));
        sendJson(res, 200, { ok: true, commit: stdout.trim() });
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        const stderr = e.stderr ?? e.message ?? "";
        sendApiError(res, 400, "bad_request", `git commit failed: ${stderr.slice(0, 500)}`);
      }
    });
  }
}
