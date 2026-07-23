import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { seekforgeHome } from "../memory/store.js";
import { readUtf8FileBoundedSync } from "../util/fs.js";
import { loadPluginContributions } from "../plugins/index.js";
import { BUILTIN_SKILLS } from "./builtins.js";
import type { Skill, SkillScope } from "./types.js";

const skillJsonSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string()),
  triggers: z.array(z.string()),
  appliesTo: z
    .object({
      languages: z.array(z.string()).optional(),
      frameworks: z.array(z.string()).optional(),
      filePatterns: z.array(z.string()).optional(),
    })
    .optional(),
  priority: z.number().optional(),
  enabled: z.boolean().optional(),
  risk: z.enum(["low", "medium", "high"]).optional(),
});

export const MAX_SKILL_DEFINITION_BYTES = 256 * 1024;
const MAX_SKILL_METADATA_BYTES = 64 * 1024;

/** A skills root directory plus the scope its skills get. */
export type SkillsDir = { scope: SkillScope; path: string };

/**
 * Merges BUILTIN_SKILLS with the skills found under each dir, in order: later
 * dirs override earlier ones (and builtins) by id. Disabled skills are removed
 * AFTER override resolution, so an enabled:false override in a higher layer
 * disables a lower-layer skill of the same id. Malformed skill dirs (bad JSON,
 * invalid skill.json, missing SKILL.md) are skipped silently.
 */
export function loadSkillsFromDirs(dirs: SkillsDir[]): Skill[] {
  const byId = new Map<string, Skill>();
  for (const skill of BUILTIN_SKILLS) byId.set(skill.id, skill);
  for (const dir of dirs) {
    for (const skill of readSkillsRoot(dir)) byId.set(skill.id, skill);
  }
  return [...byId.values()].filter((skill) => skill.enabled);
}

function readSkillsRoot({ scope, path: root }: SkillsDir): Skill[] {
  let entries: fs.Dirent[];
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(root);
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skill = readSkillDir(scope, path.join(root, entry.name), rootReal);
    if (skill) skills.push(skill);
  }
  return skills;
}

// A disable marker is a skill.json with enabled:false and no SKILL.md; it only
// needs an id, so accept a minimal stub here even if the full schema would fail.
const disableMarkerSchema = z.object({ id: z.string().min(1), enabled: z.literal(false) });

function readSkillDir(scope: SkillScope, dir: string, allowedRootReal: string): Skill | undefined {
  let raw: unknown;
  try {
    const metadata = fs.realpathSync(path.join(dir, "skill.json"));
    if (metadata !== allowedRootReal && !metadata.startsWith(`${allowedRootReal}${path.sep}`)) return undefined;
    raw = JSON.parse(readUtf8FileBoundedSync(metadata, MAX_SKILL_METADATA_BYTES));
  } catch {
    return undefined;
  }

  const skillFile = path.join(dir, "SKILL.md");
  try {
    fs.lstatSync(skillFile);
  } catch {
    // No SKILL.md: only valid as a pure disable marker (enabled:false stub),
    // which overrides a lower-layer skill of the same id and is then filtered
    // out by loadSkillsFromDirs. Anything else is malformed → skip.
    const marker = disableMarkerSchema.safeParse(raw);
    if (!marker.success) return undefined;
    return {
      id: marker.data.id,
      scope,
      name: marker.data.id,
      description: "",
      tags: [],
      triggers: [],
      priority: 50,
      enabled: false,
      risk: "medium",
      content: "",
    };
  }

  let content: string;
  try {
    const physical = fs.realpathSync(skillFile);
    const inside = physical === allowedRootReal || physical.startsWith(`${allowedRootReal}${path.sep}`);
    if (!inside) return undefined;
    content = readUtf8FileBoundedSync(physical, MAX_SKILL_DEFINITION_BYTES);
  } catch {
    // Broken links and unreadable files are malformed skills, not disable markers.
    return undefined;
  }
  const parsed = skillJsonSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const json = parsed.data;
  return {
    id: json.id,
    scope,
    name: json.name,
    description: json.description,
    tags: json.tags,
    triggers: json.triggers,
    appliesTo: json.appliesTo,
    // Clamp to [0,100]: select.ts folds priority/100 into the score as a
    // tie-breaker, so an out-of-range value (e.g. a crafted priority: 500) would
    // outweigh genuine match signal and reorder/evict real matches.
    priority: Math.max(0, Math.min(100, json.priority ?? 50)),
    enabled: json.enabled ?? true,
    risk: json.risk ?? "medium",
    content,
  };
}

/**
 * Loads builtin + global (~/.seekforge/skills) + project (.seekforge/skills)
 * skills; a project/global skill with the same id overrides lower layers.
 * Disabled skills are excluded. Malformed skill dirs are skipped, never thrown.
 */
export function loadSkills(workspace: string): Skill[] {
  const pluginRoots = loadPluginContributions(workspace).skillRoots;
  return loadSkillsFromDirs([
    ...pluginRoots.map((path) => ({ scope: "global" as const, path })),
    { scope: "global", path: path.join(seekforgeHome(), ".seekforge", "skills") },
    { scope: "project", path: path.join(workspace, ".seekforge", "skills") },
  ]);
}
