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

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Most-recent-first; capped so the file/menu stay bounded. */
const MAX_RECENTS = 15;

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
  return join(seekforgeHome(), ".seekforge", "workspaces.json");
}

/** Reads the recents list, newest first. Missing/corrupt file → empty list. */
export function loadRecents(): RecentWorkspace[] {
  try {
    const raw = readFileSync(recentsFilePath(), "utf8");
    const parsed = JSON.parse(raw) as { recents?: unknown };
    if (!parsed || !Array.isArray(parsed.recents)) return [];
    const out: RecentWorkspace[] = [];
    for (const e of parsed.recents) {
      if (e && typeof e === "object" && typeof (e as RecentWorkspace).path === "string") {
        const r = e as RecentWorkspace;
        out.push({
          path: r.path,
          name: typeof r.name === "string" && r.name ? r.name : basename(r.path) || r.path,
          lastOpened: typeof r.lastOpened === "number" ? r.lastOpened : 0,
        });
      }
    }
    return out.sort((a, b) => b.lastOpened - a.lastOpened).slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

function saveRecents(list: RecentWorkspace[]): void {
  const file = recentsFilePath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ recents: list }, null, 2)}\n`, { mode: 0o600 });
}

/** Moves `path` to the front of the recents list (de-duplicated) and persists. */
export function rememberRecent(path: string): RecentWorkspace[] {
  const abs = resolve(path);
  const entry: RecentWorkspace = { path: abs, name: basename(abs) || abs, lastOpened: Date.now() };
  const rest = loadRecents().filter((r) => resolve(r.path) !== abs);
  const next = [entry, ...rest].slice(0, MAX_RECENTS);
  saveRecents(next);
  return next;
}

/** Removes `path` from the recents list and persists. Returns the new list. */
export function forgetRecent(path: string): RecentWorkspace[] {
  const abs = resolve(path);
  const next = loadRecents().filter((r) => resolve(r.path) !== abs);
  saveRecents(next);
  return next;
}

/** True when `path` exists and is a directory (cheap validation for opening). */
export function isWorkspaceDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
