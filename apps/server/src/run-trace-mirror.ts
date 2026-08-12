/**
 * Brings an isolated run's JSONL session trace back to the checkout that owns
 * its ledger.
 *
 * `run-isolation.ts` sends a writable detached run into a dedicated git
 * worktree; this is the other half. The agent writes its trace under the
 * WORKTREE's `.seekforge/sessions/`, a directory `git worktree remove --force`
 * deletes, while the run ledger (`.seekforge/runs.jsonl`) stays in the base
 * checkout — so the base recorded a `sessionId` that nothing in the base could
 * open, and discarding the worktree destroyed the audit trail this project
 * claims to keep. Every session such a run creates is copied into the ledger
 * owner when the run ends.
 *
 * The API is a begin/finish pair on purpose. Mirroring needs to know which
 * sessions already existed BEFORE the run, and a caller that forgets that
 * snapshot copies unrelated history; a caller that forgets the `execution ===
 * ledger` case mirrors a workspace onto itself. Both are captured here, so a
 * new call site only has to begin before the run and finish after it.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { listSessions } from "@seekforge/core";
import { readProjectFile, writeProjectFileAtomic } from "./config.js";
import type { RunManager } from "./run-ledger.js";

/**
 * The files a session directory owns. The mirror copies these BY NAME: the run
 * can write whatever it likes inside its own worktree, and copying a directory
 * listing would let it place arbitrary files into the base checkout's session
 * store. Keep in sync with core's session trace writers (`createSessionTrace`,
 * `writeSessionMeta`, `writeCompactionSnapshot`, `appendCheckpoint`).
 */
export const SESSION_TRACE_FILES = [
  "session.json",
  "messages.jsonl",
  "tool-calls.jsonl",
  "events.jsonl",
  "checkpoints.jsonl",
  "compaction.json",
  "summary.md",
] as const;

/**
 * Per-file ceiling for the mirror. Deliberately core's own session-text ceiling
 * (`MAX_SESSION_TEXT_BYTES`, 64 MiB) rather than the server's smaller
 * project-state limit: a trace the base checkout would happily replay must be a
 * trace the mirror can carry, or the cap itself becomes a way to lose one.
 */
const MAX_SESSION_TRACE_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Bounds on one run's mirror. An isolated run can write as many session
 * directories as it likes inside its own worktree, and this copy is synchronous
 * server work: without a ceiling a runaway (or hostile) run turns the end of
 * its own run into an unbounded stall and a second copy of everything it wrote.
 * Whatever is left over is reported as a failure rather than dropped silently.
 */
const MAX_MIRRORED_SESSIONS = 64;
const MAX_MIRRORED_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * Failures named individually on the run before the rest are counted. One
 * bounded notice per run, not one per failure: a run that creates hundreds of
 * session directories would otherwise turn each one into a ledger append, and
 * the reporting would cost more than the copy it is reporting about.
 */
const MAX_REPORTED_FAILURES = 4;

/** Where a mirror reports what it could not carry: the run's own record. */
export type RunTraceLedger = {
  runManager?: RunManager | undefined;
  runId?: string | undefined;
  /** The session the run reported, or "" when it never reported one. */
  sessionId: string;
};

export type RunTraceMirrorResult = { mirrored: string[]; failures: string[] };

export type RunSessionMirror = {
  /**
   * Copies the traces produced since {@link beginRunSessionMirror} into the
   * ledger owner and records anything it could not carry on the run itself.
   * Safe to call from a `finally`: it never throws.
   */
  finish(ledger: RunTraceLedger): RunTraceMirrorResult;
};

const NO_MIRROR: RunSessionMirror = { finish: () => ({ mirrored: [], failures: [] }) };

/** Session ids present in `workspace` right now; empty when it has no session store. */
function sessionIdsIn(workspace: string): Set<string> {
  try {
    return new Set(listSessions(workspace, { includeSubagents: true }).map((meta) => meta.id));
  } catch {
    // A workspace that is gone (or has an unusable session store) has nothing
    // to compare against; the mirror below simply finds nothing to copy.
    return new Set();
  }
}

/**
 * Snapshots what `execution` already holds and returns the mirror to finish
 * when the run ends. A run that executes in its own ledger owner needs no
 * mirror at all, and gets an inert one — the caller does not repeat that test.
 *
 * Call this BEFORE the run starts writing.
 */
export function beginRunSessionMirror(execution: string, ledgerWorkspace: string): RunSessionMirror {
  if (resolve(execution) === resolve(ledgerWorkspace)) return NO_MIRROR;
  const before = sessionIdsIn(execution);
  return {
    finish: (ledger) => {
      // The session the ledger points at goes first: the caps below cut the
      // tail, and `listSessions` is newest-first, so the run's own session —
      // created before every subagent session — is otherwise the first thing a
      // dispatch-heavy run loses. That is the one session that must survive.
      const result = mirrorRunSessionTraces(execution, ledgerWorkspace, before, { first: ledger.sessionId });
      if (ledger.sessionId !== "" && !result.mirrored.includes(ledger.sessionId)) {
        result.failures.push(`session ${ledger.sessionId} produced no trace under ${execution}`);
      }
      // The trace is the audit trail; losing part of it is a fact about the run
      // and belongs in the run's own record, not only in a server log.
      if (result.failures.length > 0) {
        const named = result.failures.slice(0, MAX_REPORTED_FAILURES);
        const rest = result.failures.length - named.length;
        recordRunNotice(
          ledgerWorkspace,
          ledger,
          `session trace not mirrored to the base checkout — ${named.join("; ")}${
            rest > 0 ? `; and ${rest} more` : ""
          }`,
        );
      }
      return result;
    },
  };
}

/**
 * Copies the session traces a run produced from an isolated execution workspace
 * into the ledger owner, so `seekforge sessions`/`replay`/`audit` in the base
 * checkout can still open the run the base ledger points at after the worktree
 * is merged or discarded.
 *
 * This is a server-side copy performed AFTER the run: the agent's tools never
 * see the base checkout, and only `.seekforge/sessions/<id>/<known file>` is
 * written there — for ids core itself recognised as sessions, that did not
 * exist before the run, and that the ledger owner does not already hold. Both
 * ends go through the workspace-scoped project-path guard, which refuses
 * symlinks and any path that leaves the workspace.
 *
 * The destination check is the load-bearing one for what a run can do to
 * SOMEONE ELSE's record: a run can create session directories of its own
 * choosing inside its worktree (its edit tools write anywhere in it), so
 * without it a run could name an id the base already has and replace an earlier
 * run's audit trail with content of its own.
 *
 * What this deliberately does NOT promise is that every mirrored session was
 * produced by the agent loop. A fresh worktree has no `.seekforge/`, so the
 * before-snapshot is empty and any directory the run writes that parses as a
 * session is carried over. There is no unforgeable provenance to filter on —
 * `parentAgentId` is written by the run, and the entire trace is authored by
 * the agent process, so a run that wants to record something false can do it
 * inside its own genuine session just as easily. The guarantees that hold are:
 * only known trace filenames are written, never over an id the base already
 * has, and the run never touches the base checkout itself.
 *
 * Exported for tests; runtime callers go through {@link beginRunSessionMirror},
 * which owns the before-snapshot this takes as an argument.
 */
export function mirrorRunSessionTraces(
  from: string,
  to: string,
  skip: ReadonlySet<string>,
  options: { first?: string } = {},
): RunTraceMirrorResult {
  const mirrored: string[] = [];
  const failures: string[] = [];
  let ids: string[];
  try {
    ids = listSessions(from, { includeSubagents: true })
      .map((meta) => meta.id)
      .filter((id) => !skip.has(id));
  } catch (error) {
    return { mirrored, failures: [`session store is unreadable: ${errorMessage(error)}`] };
  }
  // `first` is copied before the caps can cut anything, and `createdAt` (which
  // orders the rest) is written by the run itself, so the order the caps apply
  // to is not left to the run alone.
  const first = options.first;
  if (first !== undefined && ids.includes(first)) ids = [first, ...ids.filter((id) => id !== first)];
  let budget = MAX_MIRRORED_TOTAL_BYTES;
  for (const id of ids) {
    // Anything already at that path in the ledger owner — a session, or a
    // directory whose meta no longer parses — is somebody else's record.
    if (existsSync(join(to, ".seekforge", "sessions", id))) {
      failures.push(`${id}: the ledger owner already has a session with this id`);
      continue;
    }
    if (mirrored.length >= MAX_MIRRORED_SESSIONS) {
      failures.push(`${id}: more than ${MAX_MIRRORED_SESSIONS} sessions in one run`);
      continue;
    }
    let copied = false;
    for (const name of SESSION_TRACE_FILES) {
      const rel = `.seekforge/sessions/${id}/${name}`;
      if (budget <= 0) {
        failures.push(`${rel}: more than ${MAX_MIRRORED_TOTAL_BYTES} bytes of trace in one run`);
        continue;
      }
      try {
        const content = readProjectFile(from, rel, Math.min(MAX_SESSION_TRACE_FILE_BYTES, budget));
        if (content === undefined) continue;
        budget -= Buffer.byteLength(content, "utf8");
        writeProjectFileAtomic(to, rel, content);
        copied = true;
      } catch (error) {
        failures.push(`${rel}: ${errorMessage(error)}`);
      }
    }
    if (copied) mirrored.push(id);
  }
  return { mirrored, failures };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Records an operator-visible warning on the run, falling back to the server log. */
function recordRunNotice(ledgerWorkspace: string, ledger: RunTraceLedger, text: string): void {
  try {
    if (ledger.runManager && ledger.runId) {
      // Sequence caching stays ON: this is an ordinary append, and invalidating
      // the cache would make the next one re-read the whole run-events file.
      ledger.runManager.appendFrame(ledgerWorkspace, ledger.runId, {
        type: "event",
        sessionId: ledger.sessionId,
        event: { type: "notice", level: "warn", message: text },
      });
      return;
    }
  } catch {
    // Never let bookkeeping about a lost trace be the thing that fails the run.
  }
  console.error(`warning: ${text}`);
}
