/**
 * Skill management: enable / disable / remove a skill, across the three layers
 * (builtin < global < project). Mutations only ever touch the global or
 * project skills directory — builtins are immutable in-package and are
 * disabled via an override marker, never edited or deleted.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { seekforgeHome } from "../memory/store.js";
import { BUILTIN_SKILLS } from "./builtins.js";

export type ManageSkillOptions = { global?: boolean };
const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function requireSkillId(id: string): void {
  if (!SKILL_ID_RE.test(id)) {
    throw new Error(`invalid skill id "${id}": must match ${SKILL_ID_RE}`);
  }
}

function skillsRoot(workspace: string, global: boolean): string {
  return global ? path.join(seekforgeHome(), ".seekforge", "skills") : path.join(workspace, ".seekforge", "skills");
}

function isBuiltin(id: string): boolean {
  return BUILTIN_SKILLS.some((s) => s.id === id);
}

/** True when a skill dir with a skill.json exists under the given root. */
function skillDirExists(root: string, id: string): boolean {
  try {
    return fs.statSync(path.join(root, id, "skill.json")).isFile();
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
  const root = skillsRoot(workspace, opts.global ?? false);
  const dir = path.join(root, id);
  const jsonPath = path.join(dir, "skill.json");

  const hasMd = (() => {
    try {
      return fs.statSync(path.join(dir, "SKILL.md")).isFile();
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
    // Flip enabled in place, preserving the rest of skill.json.
    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as unknown;
      parsed =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : { id };
    } catch {
      parsed = { id };
    }
    parsed.enabled = enabled;
    fs.writeFileSync(jsonPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
    return { id, enabled, action: "edited", path: jsonPath };
  }

  // No own dir in this layer.
  if (enabled) {
    // Re-enabling a builtin = remove any disable marker we previously wrote.
    if (isBuiltin(id)) {
      // Nothing to remove and no own dir → already enabled by default.
      return { id, enabled: true, action: "marker", path: jsonPath };
    }
    throw new Error(`unknown skill "${id}" (no skill to enable in this layer)`);
  }

  if (!isBuiltin(id)) {
    throw new Error(`unknown skill "${id}" (nothing to disable in this layer)`);
  }
  // Disable a builtin: write a minimal override marker.
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify({ id, enabled: false }, null, 2) + "\n", "utf8");
  return { id, enabled: false, action: "marker", path: jsonPath };
}

export type RemoveSkillResult = { id: string; path: string };

/**
 * Deletes a project (default) or global skill directory. Builtins cannot be
 * removed — they are disabled instead. Unknown ids throw.
 */
export function removeSkill(workspace: string, id: string, opts: ManageSkillOptions = {}): RemoveSkillResult {
  requireSkillId(id);
  const root = skillsRoot(workspace, opts.global ?? false);
  const dir = path.join(root, id);
  if (!skillDirExists(root, id)) {
    if (isBuiltin(id)) {
      throw new Error(`cannot remove builtin "${id}" (disable it instead)`);
    }
    throw new Error(`unknown skill "${id}" (no skill directory to remove)`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { id, path: dir };
}
