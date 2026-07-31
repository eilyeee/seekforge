import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { seekforgeHome } from "../memory/store.js";
import { acquireSessionLease, acquireWorkspaceSessionGuard } from "../agent/session-lease.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import {
  digestPluginDirectory,
  MAX_PLUGIN_MANIFEST_BYTES,
  PLUGIN_STATE_REL_PATH,
  readPluginManifest,
  resolvePluginStoreRoot,
  type PluginState,
} from "./load.js";
import type { PluginManifest } from "./types.js";
import { PLUGIN_API_VERSION } from "./types.js";
import { PLUGIN_ID_RE } from "./load.js";

function readState(): PluginState {
  try {
    const raw = readWorkspaceStateFile(seekforgeHome(), PLUGIN_STATE_REL_PATH, MAX_PLUGIN_MANIFEST_BYTES);
    if (raw === undefined) return { version: 1, plugins: {} };
    const parsed = JSON.parse(raw) as PluginState;
    return parsed.version === 1 && typeof parsed.plugins === "object" && parsed.plugins !== null
      ? parsed
      : { version: 1, plugins: {} };
  } catch {
    return { version: 1, plugins: {} };
  }
}

function writeState(state: PluginState): void {
  writeWorkspaceStateFileAtomic(seekforgeHome(), PLUGIN_STATE_REL_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function installedDir(id: string): string {
  const root = resolvePluginStoreRoot(seekforgeHome(), false);
  if (!root) throw new Error("plugin store does not exist");
  return join(root, id);
}

function rollbackDir(id: string): string {
  return join(dirname(installedDir(id)), `.rollback-${id}`);
}

export type InstallPluginResult = { manifest: PluginManifest; path: string; digest: string; updated: boolean };

export function createPluginScaffold(workspace: string, id: string): { manifest: PluginManifest; path: string } {
  if (!PLUGIN_ID_RE.test(id)) throw new Error("plugin id must use lowercase letters, digits, and dashes");
  const guard = acquireWorkspaceSessionGuard(workspace);
  try {
    const root = resolvePluginStoreRoot(workspace, true)!;
    const path = join(root, id);
    if (existsSync(path)) throw new Error(`plugin ${id} already exists`);
    mkdirSync(path, { mode: 0o700 });
    try {
      mkdirSync(join(path, "skills"), { mode: 0o700 });
      mkdirSync(join(path, "agents"), { mode: 0o700 });
      const manifest: PluginManifest = {
        apiVersion: PLUGIN_API_VERSION,
        id,
        name: id,
        version: "0.1.0",
        description: "SeekForge plugin",
        contributes: { skillRoots: ["skills"], agentRoots: ["agents"] },
      };
      writeFileSync(join(path, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      return { manifest, path };
    } catch (error) {
      rmSync(path, { recursive: true, force: true });
      throw error;
    }
  } finally {
    guard.release();
  }
}

/** Installs a bounded, link-free local plugin atomically. Installed plugins start disabled. */
export function installPlugin(sourcePath: string, options: { force?: boolean } = {}): InstallPluginResult {
  const lease = acquireSessionLease(seekforgeHome(), "plugins-mutation");
  try {
    const source = resolve(sourcePath);
    const manifest = readPluginManifest(source);
    const digest = digestPluginDirectory(source);
    const root = resolvePluginStoreRoot(seekforgeHome(), true)!;
    const target = installedDir(manifest.id);
    const existed = existsSync(target);
    if (existed && !options.force) throw new Error(`plugin ${manifest.id} is already installed; use --force to update`);
    const temp = join(root, `.install-${manifest.id}-${randomUUID()}`);
    const backup = join(root, `.backup-${manifest.id}-${randomUUID()}`);
    const rollback = join(root, `.rollback-${manifest.id}`);
    const previousRollback = join(root, `.rollback-previous-${manifest.id}-${randomUUID()}`);
    const displacedNew = join(root, `.install-displaced-${manifest.id}-${randomUUID()}`);
    let committed = false;
    try {
      cpSync(source, temp, { recursive: true, errorOnExist: true, force: false });
      if (digestPluginDirectory(temp) !== digest) throw new Error("plugin changed while it was being installed");
      if (existed && existsSync(rollback)) renameSync(rollback, previousRollback);
      if (existed) renameSync(target, backup);
      renameSync(temp, target);
      if (existsSync(backup)) renameSync(backup, rollback);
      committed = true;
    } catch (error) {
      if (existsSync(target) && existsSync(backup)) {
        renameSync(target, displacedNew);
        renameSync(backup, target);
      } else if (!existsSync(target) && existsSync(backup)) {
        renameSync(backup, target);
      }
      if (existsSync(previousRollback) && !existsSync(rollback)) renameSync(previousRollback, rollback);
      throw error;
    } finally {
      if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
      if (existsSync(displacedNew) && existsSync(target)) rmSync(displacedNew, { recursive: true, force: true });
      if (committed && existsSync(previousRollback)) rmSync(previousRollback, { recursive: true, force: true });
    }
    const state = readState();
    state.plugins[manifest.id] = { enabled: false, digest, updatedAt: new Date().toISOString() };
    writeState(state);
    return { manifest, path: target, digest, updated: existed };
  } finally {
    lease.release();
  }
}

/** Atomically restores the previous installed version and disables it for review. */
export function rollbackPlugin(id: string): InstallPluginResult {
  if (!PLUGIN_ID_RE.test(id)) throw new Error("invalid plugin id");
  const lease = acquireSessionLease(seekforgeHome(), "plugins-mutation");
  try {
    const target = installedDir(id);
    const rollback = rollbackDir(id);
    if (!existsSync(target) || !existsSync(rollback)) throw new Error(`plugin ${id} has no rollback version`);
    const manifest = readPluginManifest(rollback);
    if (manifest.id !== id) throw new Error(`rollback manifest id does not match ${id}`);
    const digest = digestPluginDirectory(rollback);
    const displaced = join(dirname(target), `.rollback-swap-${id}-${randomUUID()}`);
    renameSync(target, displaced);
    try {
      renameSync(rollback, target);
      renameSync(displaced, rollback);
    } catch (error) {
      if (existsSync(target) && existsSync(displaced) && !existsSync(rollback)) {
        renameSync(target, rollback);
        renameSync(displaced, target);
      } else if (!existsSync(target) && existsSync(displaced)) {
        renameSync(displaced, target);
      }
      throw error;
    }
    const state = readState();
    state.plugins[id] = { enabled: false, digest, updatedAt: new Date().toISOString() };
    writeState(state);
    return { manifest, path: target, digest, updated: true };
  } finally {
    lease.release();
  }
}

export function setPluginEnabled(id: string, enabled: boolean): { id: string; enabled: boolean; digest: string } {
  if (!PLUGIN_ID_RE.test(id)) throw new Error("invalid plugin id");
  const lease = acquireSessionLease(seekforgeHome(), "plugins-mutation");
  try {
    const target = installedDir(id);
    const manifest = readPluginManifest(target);
    if (manifest.id !== id) throw new Error(`plugin manifest id does not match ${id}`);
    const digest = digestPluginDirectory(target);
    const state = readState();
    state.plugins[id] = { enabled, digest, updatedAt: new Date().toISOString() };
    writeState(state);
    return { id, enabled, digest };
  } finally {
    lease.release();
  }
}

export function removePlugin(id: string): { id: string; removed: string } {
  if (!PLUGIN_ID_RE.test(id)) throw new Error("invalid plugin id");
  const lease = acquireSessionLease(seekforgeHome(), "plugins-mutation");
  try {
    const target = installedDir(id);
    if (!existsSync(target)) throw new Error(`plugin ${id} is not installed`);
    const trash = join(dirname(target), `.removed-${basename(target)}-${randomUUID()}`);
    const rollback = rollbackDir(id);
    renameSync(target, trash);
    rmSync(trash, { recursive: true, force: true });
    if (existsSync(rollback)) rmSync(rollback, { recursive: true, force: true });
    const state = readState();
    delete state.plugins[id];
    writeState(state);
    return { id, removed: target };
  } finally {
    lease.release();
  }
}
