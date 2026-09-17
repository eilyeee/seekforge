/**
 * Best-effort rewind checkpoints for shell commands.
 *
 * Write tools snapshot a file before they touch it; a shell command gives no
 * such notice. In a git work tree the next best thing is a before/after
 * comparison: before the command, record which files are uncommitted and keep
 * their content; after it, ask git again. A file that changed was either
 * uncommitted before (its snapshot is the pre-content), committed and clean
 * (HEAD holds the pre-content), or new (rewind deletes it).
 *
 * What this cannot see, and says so in the note it records: anything outside a
 * git work tree, ignored files, sensitive files, changes a command makes to git
 * history itself (commits, branch switches, stashes of clean files), and edits
 * by other processes that happen to land while the command runs.
 */
import { execFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { compareByCodePoints, isSensitiveBasename, isSensitiveRelPath } from "@seekforge/shared";
import { scrubSecretEnv } from "../util/scrub-env.js";

/** Tells the checkpoint sink where an entry came from. */
export type CheckpointOrigin = { source: "shell"; command: string };

/** What one shell command's checkpoint covered — or why it covered nothing. */
export type ShellCheckpointNote = {
  command: string;
  /**
   * `recorded`: every detected change has a checkpoint. `partial`: some
   * changed files could not be snapshotted (listed in `unrestorable`).
   * `skipped`: nothing was recorded (`reason` says why).
   */
  status: "recorded" | "partial" | "skipped";
  reason?: string;
  /** Workspace-relative paths that received a checkpoint entry. */
  files?: string[];
  unrestorable?: Array<{ path: string; reason: string }>;
  /** The command moved HEAD (a commit, checkout, reset …), which rewind does not undo. */
  headMoved?: { from: string | null; to: string | null };
};

export const SHELL_CHECKPOINT_LIMITS = {
  /** Uncommitted files snapshotted before, and changed files examined after. */
  maxFiles: 500,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  gitTimeoutMs: 10_000,
} as const;

/** SeekForge's own state changes while a command runs (the event trace); never the command's doing. */
const STATE_DIR_PATHSPEC = ":(exclude).seekforge";

type Limits = { maxFiles: number; maxFileBytes: number; maxTotalBytes: number; gitTimeoutMs: number };

type GitOutcome = { ok: true; stdout: Buffer } | { ok: false; unavailable: boolean; message: string };

function runGit(
  cwd: string,
  args: string[],
  opts: { input?: string; timeoutMs: number; signal?: AbortSignal | undefined },
): Promise<GitOutcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(
        "git",
        // Status must not rewrite the index (a user's concurrent git would hit
        // index.lock), and must not start a repository-configured fsmonitor.
        ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
        {
          cwd,
          encoding: "buffer",
          env: { ...scrubSecretEnv(), LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" },
          maxBuffer: 64 * 1024 * 1024,
          timeout: opts.timeoutMs,
          ...(opts.signal ? { signal: opts.signal } : {}),
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            const code = (error as NodeJS.ErrnoException).code;
            resolve({ ok: false, unavailable: code === "ENOENT", message: error.message });
            return;
          }
          resolve({ ok: true, stdout: stdout as Buffer });
        },
      );
    } catch (error) {
      resolve({ ok: false, unavailable: false, message: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input ?? "");
  });
}

type FileState =
  | { kind: "absent" }
  | { kind: "text"; text: string; size: number; mtimeMs: number }
  | { kind: "opaque"; reason: string; size: number; mtimeMs: number };

/** Decodes bytes that round-trip as UTF-8 text; checkpoints store strings. */
function textOf(bytes: Buffer): { text: string } | { reason: string } {
  if (bytes.includes(0)) return { reason: "binary file" };
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) return { reason: "not valid UTF-8" };
  return { text };
}

class SnapshotTooLarge extends Error {}

function readState(abs: string, limits: Limits, budget?: { remaining: number }): FileState {
  let stamp = { size: -1, mtimeMs: -1 };
  try {
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st) return { kind: "absent" };
    stamp = { size: st.size, mtimeMs: st.mtimeMs };
    if (st.isSymbolicLink()) return { kind: "opaque", reason: "symbolic link", ...stamp };
    if (!st.isFile()) return { kind: "opaque", reason: "not a regular file", ...stamp };
    if (st.size > limits.maxFileBytes) return { kind: "opaque", reason: "larger than the snapshot limit", ...stamp };
    if (budget) {
      budget.remaining -= st.size;
      if (budget.remaining < 0) throw new SnapshotTooLarge();
    }
    const decoded = textOf(readFileSync(abs));
    return "text" in decoded
      ? { kind: "text", text: decoded.text, ...stamp }
      : { kind: "opaque", ...decoded, ...stamp };
  } catch (error) {
    if (error instanceof SnapshotTooLarge) throw error;
    return { kind: "opaque", reason: "unreadable", ...stamp };
  }
}

function sameState(before: FileState, now: FileState): boolean {
  if (before.kind === "absent" || now.kind === "absent") return before.kind === now.kind;
  if (before.size === now.size && before.mtimeMs === now.mtimeMs) return true;
  if (before.kind === "text" && now.kind === "text") return before.text === now.text;
  return false;
}

type StatusEntry = { xy: string; path: string };

/** `git status --porcelain=v1 -z` → root-relative paths. */
function parsePorcelain(out: Buffer): StatusEntry[] {
  const tokens = out.toString("utf8").split("\0");
  const entries: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.length < 4 || token[2] !== " ") continue;
    const xy = token.slice(0, 2);
    entries.push({ xy, path: token.slice(3) });
    // --no-renames makes these rare; the source path of a rename/copy follows.
    if (xy[0] === "R" || xy[0] === "C") {
      const source = tokens[++i];
      if (source) entries.push({ xy: "D ", path: source });
    }
  }
  return entries;
}

function isSensitive(rel: string): boolean {
  return isSensitiveBasename(path.posix.basename(rel)) || isSensitiveRelPath(rel);
}

type Probe = { ok: true; head: string | null; paths: string[] } | { ok: false; reason: string };

async function probe(workspace: string, prefix: string, limits: Limits, signal?: AbortSignal): Promise<Probe> {
  const head = await runGit(workspace, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], {
    timeoutMs: limits.gitTimeoutMs,
    signal,
  });
  const status = await runGit(
    workspace,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", ".", STATE_DIR_PATHSPEC],
    { timeoutMs: limits.gitTimeoutMs, signal },
  );
  if (!status.ok) return { ok: false, reason: `git status failed: ${status.message.slice(0, 200)}` };
  const paths = new Set<string>();
  for (const entry of parsePorcelain(status.stdout)) {
    // Porcelain paths are relative to the repository root; the workspace may be
    // a subdirectory of it (the pathspec keeps everything inside it).
    if (!entry.path.startsWith(prefix)) continue;
    const rel = entry.path.slice(prefix.length);
    if (rel === "" || rel.endsWith("/") || rel.includes("\n") || isSensitive(rel)) continue;
    paths.add(rel);
  }
  const headOid = head.ok ? head.stdout.toString("utf8").trim() || null : null;
  return { ok: true, head: headOid, paths: [...paths].sort(compareByCodePoints) };
}

export type ShellBaseline =
  | { kind: "skipped"; reason: string }
  | { kind: "ready"; prefix: string; head: string | null; files: Map<string, FileState> };

/** Records the uncommitted state a command starts from. Never throws. */
export async function captureShellBaseline(
  workspace: string,
  opts: { signal?: AbortSignal; limits?: Partial<Limits> } = {},
): Promise<ShellBaseline> {
  const limits: Limits = { ...SHELL_CHECKPOINT_LIMITS, ...opts.limits };
  try {
    const where = await runGit(workspace, ["rev-parse", "--is-inside-work-tree", "--show-prefix"], {
      timeoutMs: limits.gitTimeoutMs,
      signal: opts.signal,
    });
    const cancelled = { kind: "skipped", reason: "the run was cancelled before the checkpoint was taken" } as const;
    if (!where.ok) {
      if (opts.signal?.aborted) return cancelled;
      return { kind: "skipped", reason: where.unavailable ? "git is not available" : "not a git work tree" };
    }
    const [inside, prefix = ""] = where.stdout.toString("utf8").split("\n");
    if (inside !== "true") return { kind: "skipped", reason: "not a git work tree" };
    const state = await probe(workspace, prefix, limits, opts.signal);
    if (!state.ok) return opts.signal?.aborted ? cancelled : { kind: "skipped", reason: state.reason };
    if (state.paths.length > limits.maxFiles) {
      return {
        kind: "skipped",
        reason: `${state.paths.length} uncommitted files exceed the ${limits.maxFiles}-file checkpoint limit`,
      };
    }
    const budget = { remaining: limits.maxTotalBytes };
    const files = new Map<string, FileState>();
    for (const rel of state.paths) files.set(rel, readState(path.join(workspace, rel), limits, budget));
    return { kind: "ready", prefix, head: state.head, files };
  } catch (error) {
    if (error instanceof SnapshotTooLarge) {
      return { kind: "skipped", reason: "uncommitted files exceed the checkpoint size limit" };
    }
    return { kind: "skipped", reason: `checkpoint failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export type ShellChanges = {
  entries: Array<{ path: string; before: string | null }>;
  note: Omit<ShellCheckpointNote, "command">;
};

/**
 * Compares the work tree with a baseline and returns one checkpoint entry per
 * changed file. Deliberately not bound to the run's abort signal: a cancelled
 * command has still changed files, and those are what rewind needs.
 */
export async function collectShellChanges(
  workspace: string,
  baseline: ShellBaseline,
  opts: { limits?: Partial<Limits> } = {},
): Promise<ShellChanges> {
  if (baseline.kind === "skipped") return { entries: [], note: { status: "skipped", reason: baseline.reason } };
  const limits: Limits = { ...SHELL_CHECKPOINT_LIMITS, ...opts.limits };
  try {
    const after = await probe(workspace, baseline.prefix, limits);
    if (!after.ok) return { entries: [], note: { status: "skipped", reason: after.reason } };
    const fresh = after.paths.filter((rel) => !baseline.files.has(rel));
    if (fresh.length > limits.maxFiles) {
      return {
        entries: [],
        note: {
          status: "skipped",
          reason: `the command changed more than ${limits.maxFiles} files, over the checkpoint limit`,
        },
      };
    }

    const entries: ShellChanges["entries"] = [];
    const unrestorable: Array<{ path: string; reason: string }> = [];
    for (const [rel, before] of baseline.files) {
      const now = readState(path.join(workspace, rel), limits);
      if (sameState(before, now)) continue;
      if (before.kind === "opaque") unrestorable.push({ path: rel, reason: before.reason });
      else entries.push({ path: rel, before: before.kind === "text" ? before.text : null });
    }

    // Files that were clean (or did not exist) before the command: HEAD holds
    // the pre-content of a clean tracked file; anything else is new.
    const specs = fresh.map((rel) => `${baseline.head ?? ""}:${baseline.prefix}${rel}`);
    const kinds =
      baseline.head !== null && specs.length > 0
        ? await runGit(workspace, ["cat-file", "--batch-check"], {
            input: `${specs.join("\n")}\n`,
            timeoutMs: limits.gitTimeoutMs,
          })
        : undefined;
    if (kinds && !kinds.ok) {
      return {
        entries: [],
        note: { status: "skipped", reason: `git cat-file failed: ${kinds.message.slice(0, 200)}` },
      };
    }
    const lines = kinds?.ok ? kinds.stdout.toString("utf8").split("\n") : [];
    for (let i = 0; i < fresh.length; i++) {
      const rel = fresh[i]!;
      const [, type, size] = (lines[i] ?? "").split(" ");
      if (baseline.head === null || lines[i]?.endsWith(" missing") || type === undefined) {
        if (readState(path.join(workspace, rel), limits).kind !== "absent") entries.push({ path: rel, before: null });
        continue;
      }
      if (type !== "blob") {
        unrestorable.push({ path: rel, reason: `not a regular file in HEAD (${type})` });
        continue;
      }
      if (Number(size) > limits.maxFileBytes) {
        unrestorable.push({ path: rel, reason: "larger than the snapshot limit" });
        continue;
      }
      // --filters applies the same eol/smudge conversion a checkout would, so
      // the restored bytes match what was on disk rather than the stored blob.
      const blob = await runGit(workspace, ["cat-file", "--filters", specs[i]!], { timeoutMs: limits.gitTimeoutMs });
      if (!blob.ok) {
        unrestorable.push({ path: rel, reason: "could not read its committed content" });
        continue;
      }
      const decoded = textOf(blob.stdout);
      if ("text" in decoded) entries.push({ path: rel, before: decoded.text });
      else unrestorable.push({ path: rel, reason: decoded.reason });
    }

    entries.sort((a, b) => compareByCodePoints(a.path, b.path));
    unrestorable.sort((a, b) => compareByCodePoints(a.path, b.path));
    const note: ShellChanges["note"] = {
      status: unrestorable.length > 0 ? "partial" : "recorded",
      files: entries.map((entry) => entry.path),
      ...(unrestorable.length > 0 ? { unrestorable } : {}),
      ...(after.head !== baseline.head ? { headMoved: { from: baseline.head, to: after.head } } : {}),
    };
    return { entries, note };
  } catch (error) {
    return {
      entries: [],
      note: {
        status: "skipped",
        reason: `checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}
