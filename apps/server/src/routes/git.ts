/**
 * Source-control routes: /api/diff, /api/git/status, stage/unstage/discard
 * and /api/git/commit, plus the git exec helpers they share.
 */

import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";
import { promisify } from "node:util";
import { acquireWorkspaceSessionGuard, SessionBusyError } from "@seekforge/core";
import { readJsonBody, sendApiError, sendJson } from "../http.js";
import type { RouteCtx } from "./context.js";

const execFileAsync = promisify(execFile);

/**
 * execFile options for git, forcing the C locale so stderr messages (e.g.
 * "not a git repository") are in English regardless of the host's language —
 * our notGit detection matches on those English strings.
 */
const GIT_EXEC = (cwd: string): { cwd: string; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv } => ({
  cwd,
  timeout: 30_000,
  maxBuffer: 10_000_000,
  env: { ...process.env, LC_ALL: "C", LANG: "C" },
});

/** Current git diff of the workspace (no shell; capped at 2 MB). */
async function gitDiff(
  workspace: string,
  staged: boolean,
): Promise<{ diff: string; truncated: boolean; notGit?: boolean }> {
  // core.quotepath=false: emit non-ASCII paths verbatim (UTF-8) rather than
  // octal-escaped and double-quoted, matching the discard endpoint's probe.
  const args = ["-c", "core.quotepath=false", ...(staged ? ["diff", "--cached"] : ["diff"])];
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
    if (/not a git repository/i.test(stderr)) {
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
    const e = err as { code?: string | number; stderr?: string; message?: string };
    if (e.code === "ENOENT") throw err;
    const stderr = e.stderr ?? e.message ?? "";
    if (/not a git repository/i.test(stderr)) {
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
