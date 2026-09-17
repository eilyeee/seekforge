/**
 * Workspace coordination for edit-mode subagents.
 *
 * - An in-process, per-workspace edit lock: two edit agents never write the
 *   same checkout at once (an agent without isolation holds it for its whole
 *   run; an isolated agent only while its change is applied).
 * - Isolated agents: a managed git worktree per nested run, whose change comes
 *   back as a patch the parent applies through its own permission flow — or
 *   stays on the worktree branch for a person to review.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PermissionRequest } from "@seekforge/shared";
import { readSessionText, writeSessionText } from "../agent/trace.js";
import { enforcePermission } from "../tools/permissions.js";
import type { ToolContext } from "../tools/index.js";
import { resolveForWrite } from "../tools/sandbox.js";
import { abortablePromise } from "../util/abort.js";
import { readUtf8FileBoundedSync } from "../util/fs.js";
import {
  applyWorktreePatch,
  commitStagedWorktree,
  createWorktree,
  removeWorktree,
  stageWorktreeChanges,
  worktreeHeadRevision,
  worktreeLocation,
  worktreeSlug,
} from "../worktree.js";

const editLocks = new Map<string, Promise<void>>();

function lockKey(workspace: string): string {
  try {
    return realpathSync.native(workspace);
  } catch {
    return resolve(workspace);
  }
}

/**
 * Takes this workspace's edit lock only if no one holds or awaits it, and
 * returns its release; undefined otherwise. Synchronous, so an uncontended
 * edit agent starts exactly when it did before the lock existed.
 */
export function tryAcquireAgentEditLock(workspace: string): (() => void) | undefined {
  const key = lockKey(workspace);
  if (editLocks.has(key)) return undefined;
  let releaseMine!: () => void;
  const mine = new Promise<void>((resolve) => {
    releaseMine = resolve;
  });
  editLocks.set(key, mine);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseMine();
    if (editLocks.get(key) === mine) editLocks.delete(key);
  };
}

/**
 * Waits for this workspace's edit lock (FIFO) and returns its release. A
 * cancelled wait gives its place up without ever holding the lock.
 */
export async function acquireAgentEditLock(workspace: string, signal?: AbortSignal): Promise<() => void> {
  const key = lockKey(workspace);
  const previous = editLocks.get(key) ?? Promise.resolve();
  let releaseMine!: () => void;
  const mine = new Promise<void>((resolve) => {
    releaseMine = resolve;
  });
  const tail = previous.then(() => mine);
  editLocks.set(key, tail);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releaseMine();
    if (editLocks.get(key) === tail) editLocks.delete(key);
  };
  try {
    await abortablePromise(previous, signal, () => new Error("cancelled while waiting for another edit agent"));
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

export type AgentWorktree = {
  /** Physical path of the worktree checkout. */
  path: string;
  branch: string;
  /** The nested run's workspace: the worktree, or the same subdirectory inside it. */
  projectPath: string;
  /** Commit the worktree was created from; every diff is taken against it. */
  revision: string;
  /** Top level of the parent's repository, where the patch applies. */
  baseRoot: string;
};

/** Thrown when a worktree cannot be provisioned (not a repository, no commit yet, …). */
export class AgentIsolationError extends Error {
  readonly code = "isolation_unavailable";
}

export async function createAgentWorktree(workspace: string, agentId: string): Promise<AgentWorktree> {
  try {
    const location = await worktreeLocation(workspace);
    const slug = `${worktreeSlug(`agent-${agentId}`).slice(0, 48)}-${randomBytes(4).toString("hex")}`;
    const created = await createWorktree(workspace, slug);
    const path = realpathSync.native(created.path);
    const projectPath = location.prefix ? join(path, location.prefix) : path;
    mkdirSync(projectPath, { recursive: true });
    return {
      path,
      branch: created.branch,
      projectPath,
      revision: await worktreeHeadRevision(path),
      baseRoot: location.root,
    };
  } catch (error) {
    throw new AgentIsolationError(
      `cannot isolate agent ${agentId} in a git worktree: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function discardAgentWorktree(workspace: string, worktree: AgentWorktree): Promise<void> {
  await removeWorktree(workspace, worktree.path, worktree.branch).catch(() => undefined);
}

/**
 * The session files that make a nested transcript resumable and inspectable.
 * Checkpoints stay behind on purpose: they hold the worktree's pre-write
 * content, and a rewind in the parent's checkout must never restore it there
 * (the parent records its own checkpoints when it applies the change).
 */
const TRANSCRIPT_FILES = [
  "session.json",
  "messages.jsonl",
  "events.jsonl",
  "tool-calls.jsonl",
  "summary.md",
  "compaction.json",
] as const;

/**
 * Copies a nested session's transcript between the parent's checkout and a
 * worktree, so an isolated agent's transcript outlives its worktree and
 * agent_send can resume it in a fresh one. Best-effort: a file that is
 * missing or unreadable is skipped.
 */
export function copyAgentTranscript(fromWorkspace: string, toWorkspace: string, sessionId: string): void {
  for (const name of TRANSCRIPT_FILES) {
    let content: string;
    try {
      content = readSessionText(fromWorkspace, sessionId, name);
    } catch {
      continue;
    }
    try {
      writeSessionText(toWorkspace, sessionId, name, content);
    } catch {
      // The copy is a convenience; the run's outcome does not depend on it.
    }
  }
}

export type IsolatedChangeOutcome =
  | { status: "unchanged" }
  | { status: "applied"; files: string[] }
  | {
      status: "retained";
      reason: "denied" | "refused" | "conflict" | "not_applied";
      message: string;
      files: string[];
      worktree: string;
      branch: string;
    };

/** A review diff is a prompt payload; keep it readable. */
const MAX_PREVIEW_CHARS = 100_000;
/** Pre-apply snapshots for rewind are text files up to this size. */
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;

function beforeContent(workspace: string, relPath: string): string | null | undefined {
  try {
    const target = resolveForWrite(workspace, relPath);
    const text = readUtf8FileBoundedSync(target, MAX_CHECKPOINT_BYTES);
    return text.includes("\u0000") ? undefined : text;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
}

/**
 * Settles one isolated nested run: no change → the worktree is removed; a
 * change is applied only when `apply` is set, every path passes the parent's
 * write rules, the parent's approval flow allows it, and the patch applies
 * cleanly. Anything else keeps the change committed on the worktree branch.
 */
export async function settleAgentWorktree(options: {
  workspace: string;
  worktree: AgentWorktree;
  agentId: string;
  ctx: ToolContext;
  toolName: string;
  signal?: AbortSignal;
  /** False when the run did not succeed or no one can answer a prompt. */
  apply: boolean;
  notAppliedReason?: string;
}): Promise<IsolatedChangeOutcome> {
  const { workspace, worktree, agentId, ctx } = options;
  const changes = await stageWorktreeChanges(worktree.projectPath, worktree.revision);
  if (changes.files.length === 0) {
    await discardAgentWorktree(workspace, worktree);
    return { status: "unchanged" };
  }
  const retain = async (
    reason: "denied" | "refused" | "conflict" | "not_applied",
    message: string,
  ): Promise<IsolatedChangeOutcome> => {
    await commitStagedWorktree(worktree.path, `seekforge agent ${agentId} changes`).catch(() => false);
    return {
      status: "retained",
      reason,
      message,
      files: changes.files,
      worktree: worktree.path,
      branch: worktree.branch,
    };
  };
  if (!options.apply) {
    return retain("not_applied", options.notAppliedReason ?? "the agent run did not complete");
  }

  // Each path must pass the parent's own write rules exactly as a direct edit
  // would: containment, and the deny and ask rules of both write tools. The
  // approval mode is decided once, below, for the change as a whole; the
  // run's tool allow-list already bound the agent's own writes.
  const rulesOnly: ToolContext = {
    ...ctx,
    policy: { ...ctx.policy, approvalMode: "auto", sessionAllowlist: [], allowedTools: undefined },
  };
  for (const file of changes.files) {
    try {
      resolveForWrite(workspace, file);
    } catch (error) {
      return retain("refused", error instanceof Error ? error.message : String(error));
    }
    for (const tool of ["apply_patch", "write_file"]) {
      const outcome = await enforcePermission(
        tool,
        { permission: "write", description: `Apply agent ${agentId}'s change to ${file}`, path: file },
        rulesOnly,
      );
      if (!outcome.allowed) return retain("refused", outcome.errorMessage);
    }
  }

  const listed = changes.files.slice(0, 20).join(", ") + (changes.files.length > 20 ? ", …" : "");
  const preview: NonNullable<PermissionRequest["preview"]> = {
    path: changes.files.length === 1 ? (changes.files[0] as string) : `${changes.files.length} files`,
    diff:
      changes.preview.length > MAX_PREVIEW_CHARS
        ? `${changes.preview.slice(0, MAX_PREVIEW_CHARS)}\n…[diff truncated]`
        : changes.preview,
  };
  const decision = await enforcePermission(
    options.toolName,
    {
      permission: "write",
      description: `Apply ${changes.files.length} changed file(s) from isolated agent ${agentId}: ${listed}`,
      ...(changes.files.length === 1 ? { path: changes.files[0] as string } : {}),
      preview,
    },
    ctx,
  );
  if (!decision.allowed) return retain("denied", decision.errorMessage);

  const release = await acquireAgentEditLock(workspace, options.signal);
  try {
    const check = await applyWorktreePatch(worktree.baseRoot, changes.patch, { check: true });
    if (!check.ok) return retain("conflict", check.message);
    for (const file of changes.files) {
      const before = beforeContent(workspace, file);
      if (before !== undefined) ctx.checkpoint?.(file, before);
    }
    const applied = await applyWorktreePatch(worktree.baseRoot, changes.patch);
    if (!applied.ok) return retain("conflict", applied.message);
  } finally {
    release();
  }
  await discardAgentWorktree(workspace, worktree);
  return { status: "applied", files: changes.files };
}
