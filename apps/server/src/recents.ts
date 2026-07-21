/**
 * Recently-opened workspaces — a small persisted list backing the desktop
 * "open recent project" menu. Stored as JSON under the SeekForge home
 * (`~/.seekforge/workspaces.json`, overridable via SEEKFORGE_HOME) so it is
 * shared across the Tauri shell and a plain browser, and survives restarts.
 *
 * This is deliberately separate from the in-memory WorkspaceRegistry: the
 * registry tracks what the running server is *hosting right now*; recents is the
 * durable history the UI offers for re-opening. Opening a recent registers it;
 * forgetting a recent only edits this file.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { acquireSessionLease } from "@seekforge/core";
import { readFileBounded } from "@seekforge/shared/bounded-file-read";

/** Most-recent-first; capped so the file/menu stay bounded. */
const MAX_RECENTS = 15;
const MAX_RECENT_CANDIDATES = 1000;
export const MAX_RECENTS_FILE_BYTES = 256 * 1024;
const RECENTS_LOCK_ID = "coord-server-recents";

export type RecentWorkspace = {
  /** Absolute path of the workspace root. */
  path: string;
  /** Display name (basename of the path). */
  name: string;
  /** Epoch ms of the last time it was opened. */
  lastOpened: number;
};

/** Mirrors core's seekforgeHome() without coupling the server to core internals. */
function seekforgeHome(): string {
  const override = process.env.SEEKFORGE_HOME;
  return override && override.length > 0 ? override : homedir();
}

export function recentsFilePath(): string {
  return join(realpathSync(resolve(seekforgeHome())), ".seekforge", "workspaces.json");
}

function parseRecents(raw: string): RecentWorkspace[] {
  const parsed = JSON.parse(raw) as { recents?: unknown };
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.recents)) {
    throw new Error("recents file must contain a recents array");
  }
  const out: RecentWorkspace[] = [];
  for (const e of parsed.recents.slice(0, MAX_RECENT_CANDIDATES)) {
    if (e && typeof e === "object" && typeof (e as RecentWorkspace).path === "string") {
      const r = e as RecentWorkspace;
      if (!isAbsolute(r.path)) continue;
      out.push({
        path: r.path,
        name: typeof r.name === "string" && r.name ? r.name : basename(r.path) || r.path,
        lastOpened: typeof r.lastOpened === "number" && Number.isFinite(r.lastOpened) ? r.lastOpened : 0,
      });
    }
  }
  return out.sort((a, b) => b.lastOpened - a.lastOpened).slice(0, MAX_RECENTS);
}

function loadRecentsInternal(strict: boolean): RecentWorkspace[] {
  try {
    return parseRecents(readFileBounded(recentsFilePath(), MAX_RECENTS_FILE_BYTES).toString("utf8"));
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

/** Reads the recents list, newest first. Missing/corrupt file → empty list. */
export function loadRecents(): RecentWorkspace[] {
  return loadRecentsInternal(false);
}

function saveRecents(list: RecentWorkspace[]): void {
  const file = recentsFilePath();
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== dir) {
    throw new Error("recents directory must be a physical directory");
  }
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error("recents file must not be a symlink");
  const serialized = `${JSON.stringify({ recents: list }, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECENTS_FILE_BYTES) {
    throw new Error(`recents file exceeds ${MAX_RECENTS_FILE_BYTES} bytes`);
  }
  const temp = join(dir, `.workspaces-${randomBytes(12).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, serialized, { flag: "wx", mode: 0o600 });
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } finally {
    rmSync(temp, { force: true });
  }
}

function mutateRecents(operation: (current: RecentWorkspace[]) => RecentWorkspace[]): RecentWorkspace[] {
  const home = realpathSync(resolve(seekforgeHome()));
  const lease = acquireSessionLease(home, RECENTS_LOCK_ID);
  try {
    const next = operation(loadRecentsInternal(true)).slice(0, MAX_RECENTS);
    saveRecents(next);
    return next;
  } finally {
    lease.release();
  }
}

/** Moves `path` to the front of the recents list (de-duplicated) and persists. */
export function rememberRecent(path: string): RecentWorkspace[] {
  const abs = resolve(path);
  const entry: RecentWorkspace = { path: abs, name: basename(abs) || abs, lastOpened: Date.now() };
  return mutateRecents((current) => [entry, ...current.filter((r) => resolve(r.path) !== abs)]);
}

/** Removes `path` from the recents list and persists. Returns the new list. */
export function forgetRecent(path: string): RecentWorkspace[] {
  const abs = resolve(path);
  return mutateRecents((current) => current.filter((r) => resolve(r.path) !== abs));
}

/** True when `path` exists and is a directory (cheap validation for opening). */
export function isWorkspaceDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
