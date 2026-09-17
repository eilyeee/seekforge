/**
 * Per-run record of which files the model has seen, for the read-before-edit
 * guard on apply_patch and write_file(overwrite).
 *
 * An edit is only as good as the content it was written against. Without this,
 * a model could overwrite a file it never opened, or patch one that a command,
 * a formatter, or the user changed after the model last looked — and a
 * search/replace edit that still happens to match lands on text the model has
 * not seen. The ledger remembers what the model read or wrote, and a write to
 * an existing file is refused until the model has a current view of it.
 *
 * The agent loop creates one ledger per run, seeded from the session's
 * previous runs (agent/session-file-ledger.ts): a follow-up message is a new
 * run, and re-reading every unchanged file on every turn would be pure waste.
 * The content hash is what keeps that safe — a file edited between turns no
 * longer matches. A ToolContext without a ledger (SDK callers driving the
 * dispatcher directly, `seekforge mcp-serve`) keeps the unguarded behavior.
 */

import { createHash } from "node:crypto";
import { isRecord } from "../util/guards.js";
import { ToolError } from "./errors.js";

/** What the model last saw of one file. */
export type FileStamp = {
  /** sha256 of the exact bytes (UTF-8) the model read or wrote. */
  hash: string;
  /** Local sessions only: the stat that went with it, for a cheap unchanged check. */
  mtimeMs?: number;
  size?: number;
};

export type FileLedger = {
  get(key: string): FileStamp | undefined;
  set(key: string, stamp: FileStamp): void;
  delete(key: string): void;
  /** Least recently recorded first. */
  entries(): Array<[string, FileStamp]>;
};

/** Entries kept when a ledger is persisted; the oldest go first. */
export const MAX_PERSISTED_LEDGER_ENTRIES = 1000;
const HASH_RE = /^[0-9a-f]{64}$/;

export function createFileLedger(seed: Iterable<[string, FileStamp]> = []): FileLedger {
  const entries = new Map<string, FileStamp>(seed);
  return {
    get: (key) => entries.get(key),
    set: (key, stamp) => {
      entries.delete(key);
      entries.set(key, stamp);
    },
    delete: (key) => {
      entries.delete(key);
    },
    entries: () => [...entries],
  };
}

export function serializeFileLedger(ledger: FileLedger): string {
  const files = Object.fromEntries(ledger.entries().slice(-MAX_PERSISTED_LEDGER_ENTRIES));
  return `${JSON.stringify({ version: 1, files })}\n`;
}

function isStamp(value: unknown): value is FileStamp {
  if (!isRecord(value) || typeof value.hash !== "string" || !HASH_RE.test(value.hash)) return false;
  const finite = (n: unknown): boolean => n === undefined || (typeof n === "number" && Number.isFinite(n) && n >= 0);
  return finite(value.mtimeMs) && finite(value.size) && (value.mtimeMs === undefined) === (value.size === undefined);
}

/** A ledger from its serialized form; anything malformed is simply not remembered. */
export function parseFileLedger(text: string): FileLedger {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return createFileLedger();
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.files)) return createFileLedger();
  const seed: Array<[string, FileStamp]> = [];
  for (const [key, value] of Object.entries(parsed.files)) {
    if (!isStamp(value)) continue;
    seed.push([
      key,
      { hash: value.hash, ...(value.mtimeMs !== undefined ? { mtimeMs: value.mtimeMs, size: value.size } : {}) },
    ]);
  }
  return createFileLedger(seed.slice(-MAX_PERSISTED_LEDGER_ENTRIES));
}

export function contentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function stampFor(content: string | Buffer, stat?: { mtimeMs: number; size: number }): FileStamp {
  return { hash: contentHash(content), ...(stat ? { mtimeMs: stat.mtimeMs, size: stat.size } : {}) };
}

/**
 * Refuse a write to an existing file the model has no current view of.
 *
 * `stat` short-circuits the common case (nothing touched the file). When the
 * stat moved, the content decides: a formatter that rewrote identical bytes or
 * a `touch` is not a change the model needs to re-read for.
 */
export function assertCurrentView(
  ledger: FileLedger,
  key: string,
  displayPath: string,
  current: { stat?: { mtimeMs: number; size: number }; content: () => string | Buffer },
): void {
  const seen = ledger.get(key);
  if (!seen) {
    throw new ToolError(
      "file_not_read",
      `${displayPath} already exists and has not been read in this session. Read it with read_file first, then retry the edit against its current content.`,
      { path: displayPath },
    );
  }
  if (current.stat !== undefined && seen.mtimeMs === current.stat.mtimeMs && seen.size === current.stat.size) {
    return;
  }
  if (contentHash(current.content()) === seen.hash) {
    if (current.stat) ledger.set(key, { ...seen, mtimeMs: current.stat.mtimeMs, size: current.stat.size });
    return;
  }
  throw new ToolError(
    "file_changed",
    `${displayPath} changed on disk since you last read it (another process, a command, or the user edited it). Re-read it with read_file, then retry the edit against the current content.`,
    { path: displayPath },
  );
}
