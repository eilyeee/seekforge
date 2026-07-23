import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { seekforgeHome } from "../memory/store.js";
import { readUtf8FileBoundedSync } from "../util/fs.js";
import { loadPluginContributions, type PluginContributions } from "../plugins/index.js";
import { BUILTIN_SKILLS } from "./builtins.js";
import { SKILL_ID_RE, resolveSkillsStoreRoot } from "./storage.js";
import type { Skill, SkillScope } from "./types.js";

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const skillJsonSchema = z.object({
  id: z.string().regex(SKILL_ID_RE),
  name: boundedText(120),
  description: z.string().max(2_000),
  tags: z.array(boundedText(100)).max(64),
  triggers: z.array(boundedText(200)).max(64),
  appliesTo: z
    .object({
      languages: z.array(boundedText(50)).max(32).optional(),
      frameworks: z.array(boundedText(100)).max(32).optional(),
      filePatterns: z.array(boundedText(200)).max(64).optional(),
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
export type SkillDiagnostic = {
  scope: SkillScope;
  path: string;
  id?: string;
  code: "invalid_root" | "invalid_id" | "invalid_metadata" | "missing_definition" | "invalid_definition";
  message: string;
};
export type SkillLoadResult = { skills: Skill[]; diagnostics: SkillDiagnostic[] };

/**
 * Merges BUILTIN_SKILLS with the skills found under each dir, in order: later
 * dirs override earlier ones (and builtins) by id. Disabled skills are removed
 * AFTER override resolution, so an enabled:false override in a higher layer
 * disables a lower-layer skill of the same id. Use loadSkillsDetailedFromDirs
 * when callers need diagnostics for malformed directories.
 */
export function loadSkillsFromDirs(dirs: SkillsDir[]): Skill[] {
  return loadSkillsDetailedFromDirs(dirs).skills;
}

export function loadSkillsDetailedFromDirs(dirs: SkillsDir[]): SkillLoadResult {
  const byId = new Map<string, Skill>();
  const diagnostics: SkillDiagnostic[] = [];
  for (const skill of BUILTIN_SKILLS) byId.set(skill.id, skill);
  for (const dir of dirs) {
    const loaded = readSkillsRoot(dir);
    diagnostics.push(...loaded.diagnostics);
    for (const skill of loaded.skills) byId.set(skill.id, skill);
  }
  return { skills: [...byId.values()].filter((skill) => skill.enabled), diagnostics };
}

function readSkillsRoot({ scope, path: root }: SkillsDir): SkillLoadResult {
  let entries: fs.Dirent[];
  let rootReal: string;
  try {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("root must be a physical directory");
    rootReal = fs.realpathSync(root);
    entries = fs.readdirSync(rootReal, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { skills: [], diagnostics: [] };
    return {
      skills: [],
      diagnostics: [
        {
          scope,
          path: root,
          code: "invalid_root",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!SKILL_ID_RE.test(entry.name)) {
      diagnostics.push({
        scope,
        path: path.join(rootReal, entry.name),
        id: entry.name,
        code: "invalid_id",
        message: `skill directory name must match ${SKILL_ID_RE}`,
      });
      continue;
    }
    const loaded = readSkillDir(scope, entry.name, path.join(rootReal, entry.name));
    if (loaded.skill) skills.push(loaded.skill);
    if (loaded.diagnostic) diagnostics.push(loaded.diagnostic);
  }
  return { skills, diagnostics };
}

// A disable marker is a skill.json with enabled:false and no SKILL.md; it only
// needs an id, so accept a minimal stub here even if the full schema would fail.
const disableMarkerSchema = z.object({ id: z.string().regex(SKILL_ID_RE), enabled: z.literal(false) });

function readSkillDir(
  scope: SkillScope,
  directoryId: string,
  dir: string,
): { skill?: Skill; diagnostic?: SkillDiagnostic } {
  const invalid = (code: SkillDiagnostic["code"], message: string) => ({
    diagnostic: { scope, path: dir, id: directoryId, code, message },
  });
  let raw: unknown;
  try {
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || fs.realpathSync(dir) !== dir) {
      return invalid("invalid_definition", "skill directory must be physical");
    }
    const metadata = path.join(dir, "skill.json");
    const metadataStat = fs.lstatSync(metadata);
    if (metadataStat.isSymbolicLink() || !metadataStat.isFile()) {
      return invalid("invalid_metadata", "skill.json must be a physical regular file");
    }
    raw = JSON.parse(readUtf8FileBoundedSync(metadata, MAX_SKILL_METADATA_BYTES));
  } catch (error) {
    return invalid("invalid_metadata", error instanceof Error ? error.message : String(error));
  }

  const skillFile = path.join(dir, "SKILL.md");
  try {
    fs.lstatSync(skillFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return invalid("invalid_definition", error instanceof Error ? error.message : String(error));
    }
    // No SKILL.md: only valid as a pure disable marker (enabled:false stub),
    // which overrides a lower-layer skill of the same id and is then filtered
    // out by loadSkillsFromDirs. Anything else is malformed → skip.
    const marker = disableMarkerSchema.safeParse(raw);
    if (!marker.success || marker.data.id !== directoryId) {
      return invalid("missing_definition", "missing SKILL.md or disable marker id does not match its directory");
    }
    return {
      skill: {
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
      },
    };
  }

  let content: string;
  try {
    const definitionStat = fs.lstatSync(skillFile);
    if (definitionStat.isSymbolicLink() || !definitionStat.isFile()) {
      return invalid("invalid_definition", "SKILL.md must be a physical regular file");
    }
    content = readUtf8FileBoundedSync(skillFile, MAX_SKILL_DEFINITION_BYTES);
  } catch (error) {
    return invalid("invalid_definition", error instanceof Error ? error.message : String(error));
  }
  const parsed = skillJsonSchema.safeParse(raw);
  if (!parsed.success) return invalid("invalid_metadata", parsed.error.issues[0]?.message ?? "invalid skill.json");
  const json = parsed.data;
  if (json.id !== directoryId) {
    return invalid("invalid_id", `skill id ${json.id} does not match directory ${directoryId}`);
  }
  return {
    skill: {
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
    },
  };
}

/**
 * Loads builtin + global (~/.seekforge/skills) + project (.seekforge/skills)
 * skills; a project/global skill with the same id overrides lower layers.
 * Disabled skills are excluded. Malformed skill dirs are skipped from this
 * compatibility view; loadSkillsDetailed exposes their diagnostics.
 */
export function loadSkills(workspace: string, contributions?: PluginContributions): Skill[] {
  return loadSkillsDetailed(workspace, contributions).skills;
}

export function loadSkillsDetailed(
  workspace: string,
  contributions = loadPluginContributions(workspace),
): SkillLoadResult {
  const pluginRoots = contributions.skillRoots;
  const roots: SkillsDir[] = [...pluginRoots.map((path) => ({ scope: "global" as const, path }))];
  const diagnostics: SkillDiagnostic[] = [];
  try {
    const globalRoot = resolveSkillsStoreRoot(seekforgeHome(), false);
    if (globalRoot) roots.push({ scope: "global", path: globalRoot });
  } catch (error) {
    diagnostics.push({
      scope: "global",
      path: path.join(seekforgeHome(), ".seekforge", "skills"),
      code: "invalid_root",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const projectRoot = resolveSkillsStoreRoot(workspace, false);
    if (projectRoot) roots.push({ scope: "project", path: projectRoot });
  } catch (error) {
    diagnostics.push({
      scope: "project",
      path: path.join(workspace, ".seekforge", "skills"),
      code: "invalid_root",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const loaded = loadSkillsDetailedFromDirs(roots);
  return { skills: loaded.skills, diagnostics: [...diagnostics, ...loaded.diagnostics] };
}
