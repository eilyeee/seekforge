/**
 * Skill management: enable / disable / remove a skill, across the three layers
 * (builtin < global < project). Mutations only ever touch the global or
 * project skills directory — builtins are immutable in-package and are
 * disabled via an override marker, never edited or deleted.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readUtf8FileBoundedSync } from "../util/fs.js";
import { writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { BUILTIN_SKILLS } from "./builtins.js";
import { CURRENT_SKILL_API_VERSION } from "./load.js";
import { SKILL_ID_RE, skillsStoreRoot, withSkillMutation } from "./storage.js";

export type ManageSkillOptions = { global?: boolean };
const MAX_SKILL_METADATA_BYTES = 64 * 1024;

function requireSkillId(id: string): void {
  if (!SKILL_ID_RE.test(id)) {
    throw new Error(`invalid skill id "${id}": must match ${SKILL_ID_RE}`);
  }
}

function isBuiltin(id: string): boolean {
  return BUILTIN_SKILLS.some((s) => s.id === id);
}

/** True when a skill dir with a skill.json exists under the given root. */
function skillDirExists(root: string, id: string): boolean {
  try {
    const dir = path.join(root, id);
    const dirStat = fs.lstatSync(dir);
    const metadataStat = fs.lstatSync(path.join(dir, "skill.json"));
    return (
      !dirStat.isSymbolicLink() && dirStat.isDirectory() && !metadataStat.isSymbolicLink() && metadataStat.isFile()
    );
  } catch {
    return false;
  }
}

export type SetSkillEnabledResult = {
  id: string;
  enabled: boolean;
  /** "edited" an existing skill.json, or wrote an override "marker". */
  action: "edited" | "marker";
  path: string;
};

/**
 * Enables or disables a skill at the project (default) or global layer.
 *
 *  - A skill that already lives in the target layer (its own skill.json) has
 *    its `enabled` flag flipped in place.
 *  - A BUILTIN id is disabled by writing a minimal override marker
 *    `<root>/<id>/skill.json` = {id, enabled:false}. The loader treats a
 *    same-id skill.json with enabled:false (even without SKILL.md — see
 *    load.ts) as a disable of the lower layer. Re-enabling a builtin simply
 *    removes that marker, restoring the in-package skill.
 *
 * Throws when asked to enable an unknown id that has no dir to flip.
 */
export function setSkillEnabled(
  workspace: string,
  id: string,
  enabled: boolean,
  opts: ManageSkillOptions = {},
): SetSkillEnabledResult {
  requireSkillId(id);
  const global = opts.global ?? false;
  return withSkillMutation(workspace, global, () => {
    const existingRoot = skillsStoreRoot(workspace, global, false);
    const root = existingRoot ?? skillsStoreRoot(workspace, global, true)!;
    const dir = path.join(root, id);
    const jsonPath = path.join(dir, "skill.json");

    const hasMd = (() => {
      try {
        const stat = fs.lstatSync(path.join(dir, "SKILL.md"));
        return !stat.isSymbolicLink() && stat.isFile();
      } catch {
        return false;
      }
    })();

    // Re-enabling a builtin whose dir is only a disable marker (no SKILL.md):
    // remove the marker so the in-package builtin resurfaces cleanly.
    if (enabled && isBuiltin(id) && skillDirExists(root, id) && !hasMd) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { id, enabled: true, action: "marker", path: jsonPath };
    }

    if (skillDirExists(root, id)) {
      // Flip enabled in place, preserving the rest of skill.json. Physical-leaf
      // validation above plus atomic replacement prevents symlink write-through.
      let parsed: Record<string, unknown>;
      try {
        const value = JSON.parse(readUtf8FileBoundedSync(jsonPath, MAX_SKILL_METADATA_BYTES)) as unknown;
        parsed =
          typeof value === "object" && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : { id };
      } catch {
        parsed = { id };
      }
      parsed.id = id;
      parsed.enabled = enabled;
      writeWorkspaceStateFileAtomic(root, path.join(id, "skill.json"), `${JSON.stringify(parsed, null, 2)}\n`);
      return { id, enabled, action: "edited", path: jsonPath };
    }

    // No own dir in this layer.
    if (enabled) {
      if (isBuiltin(id)) {
        return { id, enabled: true, action: "marker", path: jsonPath };
      }
      throw new Error(`unknown skill "${id}" (no skill to enable in this layer)`);
    }

    if (!isBuiltin(id)) throw new Error(`unknown skill "${id}" (nothing to disable in this layer)`);
    fs.mkdirSync(dir, { mode: 0o700 });
    writeWorkspaceStateFileAtomic(
      root,
      path.join(id, "skill.json"),
      `${JSON.stringify({ id, enabled: false }, null, 2)}\n`,
    );
    return { id, enabled: false, action: "marker", path: jsonPath };
  });
}

export type RemoveSkillResult = { id: string; path: string };

export type RepairSkillsResult = {
  repaired: Array<{ id: string; path: string }>;
  skipped: Array<{ id: string; reason: string }>;
};

/** Safely migrates legacy object-shaped skill.json files to the current API version. */
export function repairSkills(workspace: string, opts: ManageSkillOptions & { id?: string } = {}): RepairSkillsResult {
  if (opts.id !== undefined) requireSkillId(opts.id);
  const global = opts.global ?? false;
  return withSkillMutation(workspace, global, () => {
    const root = skillsStoreRoot(workspace, global, false);
    if (!root) return { repaired: [], skipped: [] };
    const ids = opts.id
      ? [opts.id]
      : fs
          .readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && SKILL_ID_RE.test(entry.name))
          .map((entry) => entry.name)
          .sort();
    const result: RepairSkillsResult = { repaired: [], skipped: [] };
    for (const id of ids) {
      const jsonPath = path.join(root, id, "skill.json");
      if (!skillDirExists(root, id)) {
        result.skipped.push({ id, reason: "missing physical skill.json" });
        continue;
      }
      try {
        const value = JSON.parse(readUtf8FileBoundedSync(jsonPath, MAX_SKILL_METADATA_BYTES)) as unknown;
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          result.skipped.push({ id, reason: "metadata is not an object" });
          continue;
        }
        const metadata = value as Record<string, unknown>;
        if (metadata.apiVersion !== undefined && metadata.apiVersion !== CURRENT_SKILL_API_VERSION) {
          result.skipped.push({ id, reason: `unsupported apiVersion ${String(metadata.apiVersion)}` });
          continue;
        }
        if (metadata.apiVersion === CURRENT_SKILL_API_VERSION) continue;
        metadata.apiVersion = CURRENT_SKILL_API_VERSION;
        metadata.id = id;
        writeWorkspaceStateFileAtomic(root, path.join(id, "skill.json"), `${JSON.stringify(metadata, null, 2)}\n`);
        result.repaired.push({ id, path: jsonPath });
      } catch (error) {
        result.skipped.push({ id, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  });
}

/**
 * Deletes a project (default) or global skill directory. Builtins cannot be
 * removed — they are disabled instead. Unknown ids throw.
 */
export function removeSkill(workspace: string, id: string, opts: ManageSkillOptions = {}): RemoveSkillResult {
  requireSkillId(id);
  const global = opts.global ?? false;
  return withSkillMutation(workspace, global, () => {
    const root = skillsStoreRoot(workspace, global, false);
    if (!root) {
      if (isBuiltin(id)) throw new Error(`cannot remove builtin "${id}" (disable it instead)`);
      throw new Error(`unknown skill "${id}" (no skill directory to remove)`);
    }
    const dir = path.join(root, id);
    if (!skillDirExists(root, id)) {
      if (isBuiltin(id)) throw new Error(`cannot remove builtin "${id}" (disable it instead)`);
      throw new Error(`unknown skill "${id}" (no physical skill directory to remove)`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return { id, path: dir };
  });
}
