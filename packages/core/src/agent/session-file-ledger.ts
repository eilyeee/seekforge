/**
 * The read-before-edit ledger (tools/file-ledger.ts), carried from one run of
 * a session to the next in a sidecar beside the transcript. Only hashes and
 * stat numbers are stored, never content.
 *
 * The file is a cache of "what the model has seen": losing it costs a re-read
 * and nothing else, so it is written without fsync (see
 * writeWorkspaceStateFileAtomic's `durable`), and not at all when a run
 * changed nothing. Best effort both ways: a ledger that cannot be read starts
 * empty, one that cannot be written is simply not remembered.
 */

import { join } from "node:path";
import { createFileLedger, type FileLedger, parseFileLedger, serializeFileLedger } from "../tools/file-ledger.js";
import { writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { readSessionText, sessionFile } from "./trace.js";

const LEDGER_FILE = "file-ledger.json";

/** What each ledger looked like when its run began, to skip a no-op save. */
const baselines = new WeakMap<FileLedger, string>();

/** The ledger for one run: empty for a new session, the session's last one on resume. */
export function openSessionFileLedger(workspace: string, sessionId: string, resuming: boolean): FileLedger {
  let ledger = createFileLedger();
  if (resuming) {
    try {
      ledger = parseFileLedger(readSessionText(workspace, sessionId, LEDGER_FILE));
    } catch {
      // absent or unreadable: start empty
    }
  }
  baselines.set(ledger, serializeFileLedger(ledger));
  return ledger;
}

export function saveSessionFileLedger(workspace: string, sessionId: string, ledger: FileLedger): void {
  const text = serializeFileLedger(ledger);
  if (baselines.get(ledger) === text) return;
  try {
    // Validates the session id and that the session directory is physical.
    sessionFile(workspace, sessionId, LEDGER_FILE, true);
    writeWorkspaceStateFileAtomic(workspace, join(".seekforge", "sessions", sessionId, LEDGER_FILE), text, {
      durable: false,
    });
    baselines.set(ledger, text);
  } catch {
    // not remembering what was read only costs a re-read next run
  }
}
