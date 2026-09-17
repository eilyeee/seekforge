import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { seekforgeHome } from "../memory/store.js";
import { readUtf8FileBoundedSync } from "../util/fs.js";
import { loadPluginContributions, type PluginContributions } from "../plugins/index.js";
import { BUILTIN_SKILLS } from "./builtins.js";
import {
  frontmatterBoolean,
  frontmatterList,
  hasFrontmatter,
  parseSkillFrontmatter,
  type SkillFrontmatter,
} from "./frontmatter.js";
import { SKILL_ID_RE, resolveClaudeSkillsRoot, resolveSkillsStoreRoot } from "./storage.js";
import { parseToolEntry, splitToolList } from "./tool-rules.js";
import type { Skill, SkillScope, SkillSource } from "./types.js";
import { compareByCodePoints } from "@seekforge/shared";

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const toolEntry = boundedText(300).superRefine((value, ctx) => {
  try {
    parseToolEntry(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
  }
});
export const SKILL_ARGUMENT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * The fields Claude Code's SKILL.md frontmatter and SeekForge's skill.json
 * share, in skill.json spelling. Both sources are validated against it.
 */
const invocationFields = {
  whenToUse: z.string().trim().max(2_000).optional(),
  argumentHint: z.string().trim().max(200).optional(),
  argumentNames: z.array(z.string().regex(SKILL_ARGUMENT_NAME_RE)).max(32).optional(),
  allowedTools: z.array(toolEntry).max(64).optional(),
  disallowedTools: z.array(toolEntry).max(64).optional(),
  model: boundedText(100).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  context: z.enum(["inline", "fork"]).optional(),
  agent: z.string().regex(SKILL_ID_RE).optional(),
  disableModelInvocation: z.boolean().optional(),
  userInvocable: z.boolean().optional(),
  paths: z.array(boundedText(200)).max(64).optional(),
};

const skillJsonSchema = z.object({
  apiVersion: z.literal(1).optional(),
  id: z.string().regex(SKILL_ID_RE),
  // Optional since SKILL.md frontmatter can carry them; see mergeDefinition.
  name: boundedText(120).optional(),
  description: z.string().max(2_000).optional(),
  tags: z.array(boundedText(100)).max(64).optional(),
  triggers: z.array(boundedText(200)).max(64).optional(),
  negativeTriggers: z.array(boundedText(200)).max(64).optional(),
  taskTypes: z.array(boundedText(50)).max(32).optional(),
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
  dependsOn: z.array(z.string().regex(SKILL_ID_RE)).max(32).optional(),
  conflictsWith: z.array(z.string().regex(SKILL_ID_RE)).max(32).optional(),
  order: z.number().int().min(-10_000).max(10_000).optional(),
  ...invocationFields,
});
type SkillJson = z.infer<typeof skillJsonSchema>;

const frontmatterSchema = z.object({
  name: boundedText(120).optional(),
  description: z.string().trim().max(2_000).optional(),
  tags: z.array(boundedText(100)).max(64).optional(),
  triggers: z.array(boundedText(200)).max(64).optional(),
  ...invocationFields,
});
type FrontmatterDefinition = z.infer<typeof frontmatterSchema>;

export const CURRENT_SKILL_API_VERSION = 1 as const;

export const MAX_SKILL_DEFINITION_BYTES = 256 * 1024;
const MAX_SKILL_METADATA_BYTES = 64 * 1024;
const MAX_DERIVED_DESCRIPTION_CHARS = 500;

/** A skills root directory plus the scope its skills get. */
export type SkillsDir = { scope: SkillScope; path: string; root?: SkillSource["root"]; pluginRoot?: string };
export type SkillDiagnostic = {
  scope: SkillScope;
  path: string;
  id?: string;
  code:
    | "invalid_root"
    | "invalid_id"
    | "invalid_metadata"
    | "missing_definition"
    | "invalid_definition"
    | "legacy_metadata"
    | "missing_dependency"
    | "dependency_cycle";
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
  const skills = [...byId.values()].filter((skill) => skill.enabled);
  const enabled = new Set(skills.map((skill) => skill.id));
  for (const skill of skills) {
    for (const dependency of skill.dependsOn ?? []) {
      if (!enabled.has(dependency)) {
        diagnostics.push({
          scope: skill.scope,
          path: skill.id,
          id: skill.id,
          code: "missing_dependency",
          message: `dependency ${dependency} is missing or disabled`,
        });
      }
    }
  }
  const state = new Map<string, "visiting" | "done">();
  const cyclic = new Set<string>();
  const visit = (id: string, stack: string[]): void => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      for (const member of stack.slice(stack.indexOf(id))) cyclic.add(member);
      return;
    }
    state.set(id, "visiting");
    const skill = byId.get(id);
    for (const dependency of skill?.dependsOn ?? []) if (enabled.has(dependency)) visit(dependency, [...stack, id]);
    state.set(id, "done");
  };
  for (const skill of skills) visit(skill.id, []);
  for (const id of [...cyclic].sort()) {
    const skill = byId.get(id)!;
    diagnostics.push({
      scope: skill.scope,
      path: id,
      id,
      code: "dependency_cycle",
      message: "skill dependency graph contains a cycle",
    });
  }
  return { skills, diagnostics };
}

function readSkillsRoot({ scope, path: root, root: kind, pluginRoot }: SkillsDir): SkillLoadResult {
  let entries: fs.Dirent[];
  let rootReal: string;
  try {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("root must be a physical directory");
    rootReal = fs.realpathSync(root);
    entries = fs.readdirSync(rootReal, { withFileTypes: true }).sort((a, b) => compareByCodePoints(a.name, b.name));
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
    const source: SkillSource = {
      format: "skill.json",
      root: kind ?? "seekforge",
      ...(pluginRoot ? { pluginRoot } : {}),
    };
    const loaded = readSkillDir(scope, source, entry.name, path.join(rootReal, entry.name));
    if (loaded.skill) skills.push(loaded.skill);
    if (loaded.diagnostics) diagnostics.push(...loaded.diagnostics);
  }
  return { skills, diagnostics };
}

// A disable marker is a skill.json with enabled:false and no SKILL.md; it only
// needs an id, so accept a minimal stub here even if the full schema would fail.
const disableMarkerSchema = z.object({ id: z.string().regex(SKILL_ID_RE), enabled: z.literal(false) });

/** A physical regular file's bounded contents; undefined when it does not exist. */
function readPhysicalFile(file: string, maxBytes: number): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${path.basename(file)} must be a physical regular file`);
  }
  return readUtf8FileBoundedSync(file, maxBytes);
}

const splitNames = (raw: string): string[] =>
  raw
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

/** Comma-separated globs; a comma inside `{a,b}` belongs to the glob. */
function splitGlobs(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of raw) {
    if (ch === "{") depth++;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out.filter(Boolean);
}

/** Frontmatter keys as Claude Code spells them, mapped to skill.json fields. */
function frontmatterDefinition(fm: SkillFrontmatter): { value?: FrontmatterDefinition; error?: string } {
  const booleans: Record<string, "disableModelInvocation" | "userInvocable"> = {
    "disable-model-invocation": "disableModelInvocation",
    "user-invocable": "userInvocable",
  };
  const raw: Record<string, unknown> = {};
  const text = (key: string): string | undefined => {
    const value = fm.fields.get(key)?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
  // Prose is clipped, not refused: an over-long description is still a skill.
  raw.name = text("name")?.slice(0, 120);
  raw.description = text("description")?.slice(0, 2_000);
  raw.whenToUse = (text("when_to_use") ?? text("when-to-use"))?.slice(0, 2_000);
  raw.argumentHint = text("argument-hint")?.slice(0, 200);
  raw.argumentNames = frontmatterList(fm, "arguments", splitNames);
  raw.allowedTools = frontmatterList(fm, "allowed-tools", splitToolList);
  raw.disallowedTools = frontmatterList(fm, "disallowed-tools", splitToolList);
  const model = text("model");
  raw.model = model === "inherit" ? undefined : model;
  raw.effort = text("effort");
  raw.context = text("context");
  raw.agent = text("agent");
  raw.paths = frontmatterList(fm, "paths", splitGlobs);
  raw.tags = frontmatterList(fm, "tags", (value) =>
    value.split(/[,|]/).map((part) => part.trim().toLowerCase()),
  )?.filter(Boolean);
  raw.triggers = (
    frontmatterList(fm, "triggers", (value) => value.split("|")) ??
    frontmatterList(fm, "trigger", (value) => value.split("|"))
  )
    ?.map((value) => value.trim())
    .filter(Boolean);
  for (const [key, field] of Object.entries(booleans)) {
    if (!fm.fields.has(key) || fm.fields.get(key)?.trim() === "") continue;
    const value = frontmatterBoolean(fm, key);
    // A flag that says something other than true/false is refused rather than
    // read as "unset": `disable-model-invocation: yes please` means yes.
    if (value === undefined) return { error: `frontmatter ${key} must be true or false` };
    raw[field] = value;
  }
  const parsed = frontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: `invalid SKILL.md frontmatter${issue ? ` (${issue.path.join(".")}: ${issue.message})` : ""}` };
  }
  return { value: parsed.data };
}

/** The error loading this SKILL.md would report, or undefined when it is valid. */
export function validateSkillMarkdown(markdown: string): string | undefined {
  try {
    return frontmatterDefinition(parseSkillFrontmatter(markdown)).error;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** First prose paragraph of the body, for skills that give no description. */
function deriveDescription(body: string): string {
  const lines: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const text = line.trim();
    if (text === "") {
      if (lines.length > 0) break;
      continue;
    }
    if (/^#{1,6}\s/.test(text) || text.startsWith("```")) {
      if (lines.length > 0) break;
      continue;
    }
    lines.push(text);
  }
  return lines.join(" ").replace(/\s+/g, " ").slice(0, MAX_DERIVED_DESCRIPTION_CHARS);
}

const nonEmpty = <T>(value: T[] | undefined): T[] | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;
const nonBlank = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim() !== "" ? value : undefined;

/**
 * skill.json keeps precedence for every field it sets to a non-empty value.
 * Empty strings and lists are what `skill create` scaffolds, so they read as
 * "unset" and let the frontmatter fill them in.
 */
function mergeDefinition(
  scope: SkillScope,
  source: SkillSource,
  id: string,
  dir: string,
  body: string,
  json: SkillJson | undefined,
  fm: FrontmatterDefinition,
): Skill {
  const pick = <K extends keyof typeof invocationFields>(key: K) => json?.[key] ?? fm[key];
  const context = pick("context");
  const optional = {
    whenToUse: nonBlank(pick("whenToUse")),
    argumentHint: nonBlank(pick("argumentHint")),
    argumentNames: nonEmpty(pick("argumentNames")),
    allowedTools: nonEmpty(pick("allowedTools")),
    disallowedTools: nonEmpty(pick("disallowedTools")),
    model: pick("model"),
    effort: pick("effort"),
    context: context === "fork" ? ("fork" as const) : undefined,
    agent: pick("agent"),
    disableModelInvocation: pick("disableModelInvocation") === true ? true : undefined,
    userInvocable: pick("userInvocable") === false ? false : undefined,
    paths: nonEmpty(pick("paths")),
  };
  const skill: Skill = {
    apiVersion: CURRENT_SKILL_API_VERSION,
    id,
    scope,
    name: json?.name ?? fm.name ?? id,
    description: nonBlank(json?.description) ?? nonBlank(fm.description) ?? deriveDescription(body),
    tags: nonEmpty(json?.tags) ?? fm.tags ?? [],
    triggers: nonEmpty(json?.triggers) ?? fm.triggers ?? [],
    negativeTriggers: json?.negativeTriggers ?? [],
    taskTypes: json?.taskTypes ?? [],
    appliesTo: json?.appliesTo,
    // Clamp to [0,100]: select.ts folds priority/100 into the score as a
    // tie-breaker, so an out-of-range value (e.g. a crafted priority: 500) would
    // outweigh genuine match signal and reorder/evict real matches.
    priority: Math.max(0, Math.min(100, json?.priority ?? 50)),
    enabled: json?.enabled ?? true,
    risk: json?.risk ?? "medium",
    dependsOn: json?.dependsOn ?? [],
    conflictsWith: json?.conflictsWith ?? [],
    order: json?.order ?? 0,
    content: body,
    dir,
    source,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) (skill as Record<string, unknown>)[key] = value;
  }
  return skill;
}

function readSkillDir(
  scope: SkillScope,
  rootSource: SkillSource,
  directoryId: string,
  dir: string,
): { skill?: Skill; diagnostics?: SkillDiagnostic[] } {
  const invalid = (code: SkillDiagnostic["code"], message: string) => ({
    diagnostics: [{ scope, path: dir, id: directoryId, code, message }],
  });
  let metadataText: string | undefined;
  try {
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || fs.realpathSync(dir) !== dir) {
      return invalid("invalid_definition", "skill directory must be physical");
    }
    metadataText = readPhysicalFile(path.join(dir, "skill.json"), MAX_SKILL_METADATA_BYTES);
  } catch (error) {
    return invalid("invalid_metadata", error instanceof Error ? error.message : String(error));
  }
  let raw: unknown;
  if (metadataText !== undefined) {
    try {
      raw = JSON.parse(metadataText);
    } catch (error) {
      return invalid("invalid_metadata", error instanceof Error ? error.message : String(error));
    }
  }

  let markdown: string | undefined;
  try {
    markdown = readPhysicalFile(path.join(dir, "SKILL.md"), MAX_SKILL_DEFINITION_BYTES);
  } catch (error) {
    return invalid("invalid_definition", error instanceof Error ? error.message : String(error));
  }

  if (markdown === undefined) {
    if (raw === undefined) return invalid("missing_definition", "directory has neither SKILL.md nor skill.json");
    // No SKILL.md: only valid as a pure disable marker (enabled:false stub),
    // which overrides a lower-layer skill of the same id and is then filtered
    // out by loadSkillsFromDirs. Anything else is malformed → skip.
    const marker = disableMarkerSchema.safeParse(raw);
    if (!marker.success || marker.data.id !== directoryId) {
      return invalid("missing_definition", "missing SKILL.md or disable marker id does not match its directory");
    }
    return {
      skill: {
        apiVersion: CURRENT_SKILL_API_VERSION,
        id: marker.data.id,
        scope,
        name: marker.data.id,
        description: "",
        tags: [],
        triggers: [],
        negativeTriggers: [],
        taskTypes: [],
        priority: 50,
        enabled: false,
        risk: "medium",
        dependsOn: [],
        conflictsWith: [],
        order: 0,
        content: "",
      },
    };
  }

  let json: SkillJson | undefined;
  if (raw !== undefined) {
    const parsed = skillJsonSchema.safeParse(raw);
    if (!parsed.success) return invalid("invalid_metadata", parsed.error.issues[0]?.message ?? "invalid skill.json");
    json = parsed.data;
    if (json.id !== directoryId) {
      return invalid("invalid_id", `skill id ${json.id} does not match directory ${directoryId}`);
    }
  }

  const fm = parseSkillFrontmatter(markdown);
  const definition = frontmatterDefinition(fm);
  if (definition.error !== undefined || definition.value === undefined) {
    return invalid("invalid_definition", definition.error ?? "invalid SKILL.md frontmatter");
  }
  // A skill.json-shaped skill keeps SKILL.md byte-for-byte unless the file
  // really opens with frontmatter, so existing digests do not move.
  const body = hasFrontmatter(markdown) ? fm.body : markdown;
  const source: SkillSource = { ...rootSource, format: json ? "skill.json" : "frontmatter" };
  const skill = mergeDefinition(scope, source, directoryId, dir, body, json, definition.value);
  if (json && json.apiVersion === undefined) {
    return {
      skill,
      diagnostics: [
        {
          scope,
          path: dir,
          id: directoryId,
          code: "legacy_metadata",
          message: "skill.json has no apiVersion; run skill repair to migrate it to version 1",
        },
      ],
    };
  }
  return { skill };
}

export type SkillSourceOptions = {
  /**
   * Read `~/.claude/skills` as well. A user-level opt-in: skills written for
   * Claude Code are loaded into every SeekForge run once it is on.
   */
  claudeUserSkills?: boolean;
};

let defaultSkillSources: SkillSourceOptions = {};

/**
 * Host seam for user-level skill-source settings (config `claudeUserSkills`).
 * Process-wide because the setting belongs to the user, not a workspace.
 */
export function configureSkillSources(options: SkillSourceOptions): void {
  defaultSkillSources = { ...options };
}

/**
 * Loads builtin + global (~/.seekforge/skills) + project (.seekforge/skills)
 * skills; a project/global skill with the same id overrides lower layers.
 * Disabled skills are excluded. Malformed skill dirs are skipped from this
 * compatibility view; loadSkillsDetailed exposes their diagnostics.
 */
export function loadSkills(
  workspace: string,
  contributions?: PluginContributions,
  options?: SkillSourceOptions,
): Skill[] {
  return loadSkillsDetailed(workspace, contributions, options).skills;
}

/**
 * The roots, lowest precedence first: plugin skills, then the user layer
 * (`~/.claude/skills` when opted in, then `~/.seekforge/skills`), then the
 * project layer (`.claude/skills`, then `.seekforge/skills`). Inside a layer
 * the SeekForge directory is read last, so it wins an id clash.
 */
export function loadSkillsDetailed(
  workspace: string,
  contributions = loadPluginContributions(workspace),
  options: SkillSourceOptions = defaultSkillSources,
): SkillLoadResult {
  const { roots, diagnostics } = skillRoots(workspace, contributions, options);
  const loaded = loadSkillsDetailedFromDirs(roots);
  return { skills: loaded.skills, diagnostics: [...diagnostics, ...loaded.diagnostics] };
}

/** The ordered roots loadSkillsDetailed reads (exported for management). */
export function skillRoots(
  workspace: string,
  contributions: PluginContributions,
  options: SkillSourceOptions = defaultSkillSources,
): { roots: SkillsDir[]; diagnostics: SkillDiagnostic[] } {
  const pluginDirs: string[] = [];
  for (const plugin of contributions.plugins) {
    if (plugin.scope !== "global" || plugin.status !== "enabled") continue;
    try {
      pluginDirs.push(fs.realpathSync(plugin.path));
    } catch {
      // A plugin that vanished contributes nothing below.
    }
  }
  const roots: SkillsDir[] = contributions.skillRoots.map((skillRoot) => {
    const pluginRoot = pluginDirs.find((dir) => skillRoot === dir || skillRoot.startsWith(`${dir}${path.sep}`));
    return {
      scope: "global" as const,
      path: skillRoot,
      root: "plugin" as const,
      ...(pluginRoot ? { pluginRoot } : {}),
    };
  });
  const diagnostics: SkillDiagnostic[] = [];
  const addRoot = (
    scope: SkillScope,
    root: SkillSource["root"],
    base: string,
    segments: string,
    resolve: () => string | undefined,
  ): void => {
    try {
      const resolved = resolve();
      if (resolved) roots.push({ scope, path: resolved, root });
    } catch (error) {
      diagnostics.push({
        scope,
        path: path.join(base, segments),
        code: "invalid_root",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const home = seekforgeHome();
  if (options.claudeUserSkills === true) {
    addRoot("global", "claude", home, ".claude/skills", () => resolveClaudeSkillsRoot(home));
  }
  addRoot("global", "seekforge", home, ".seekforge/skills", () => resolveSkillsStoreRoot(home, false));
  addRoot("project", "claude", workspace, ".claude/skills", () => resolveClaudeSkillsRoot(workspace));
  addRoot("project", "seekforge", workspace, ".seekforge/skills", () => resolveSkillsStoreRoot(workspace, false));
  return { roots, diagnostics };
}
