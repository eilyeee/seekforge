import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_ID_RE, kebabize, parseFrontmatter } from "../subagents/frontmatter.js";
import { readUtf8FileBoundedSync } from "../util/fs.js";
import { MAX_SKILL_DEFINITION_BYTES } from "./load.js";
import { withSkillMutation } from "./storage.js";
import type { Skill } from "./types.js";

/**
 * Importing external skills (Claude-Code-style SKILL.md with YAML
 * frontmatter, e.g. Meta_Kim canonical skills) into SeekForge's
 * skill.json + SKILL.md layout.
 *
 * Imported skills are procedure suggestions like any other skill — they
 * never grant permissions, and land with medium trust (docs/14 §7).
 */

export type ParsedExternalSkill = {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  tags: string[];
  /** SKILL.md body without the frontmatter block. */
  body: string;
};

/**
 * Parses an external SKILL.md and maps its frontmatter to a skill record. The
 * generic YAML-frontmatter reading (incl. `|-`/`>+` chomping indicators and
 * JSON-escaped quoted values) is shared with the subagent importer via
 * parseFrontmatter — this only adds the skill-specific field mapping.
 */
export function parseFrontmatterSkill(markdown: string): ParsedExternalSkill {
  let fields: Map<string, string>;
  let body: string;
  try {
    ({ fields, body } = parseFrontmatter(markdown));
  } catch {
    throw new Error("not an importable skill: missing YAML frontmatter (--- ... ---)");
  }

  const rawName = fields.get("name") ?? "";
  const id = kebabize(rawName);
  if (!AGENT_ID_RE.test(id) || id.length > 128) {
    throw new Error(`not an importable skill: frontmatter "name" is missing or invalid (${rawName || "empty"})`);
  }

  const description = (fields.get("description") ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  const triggers = [...new Set((fields.get("trigger") ?? "").split("|").map((s) => s.trim().slice(0, 200)))]
    .filter(Boolean)
    .slice(0, 64);
  const tags = [...new Set((fields.get("tags") ?? "").split(/[,|]/).map((s) => s.trim().toLowerCase().slice(0, 100)))]
    .filter(Boolean)
    .slice(0, 64);

  return { id, name: rawName.trim().slice(0, 120), description, triggers, tags, body: body.trim() };
}

export type ImportSkillOptions = {
  /** Skills root to write into (e.g. <ws>/.seekforge/skills or ~/.seekforge/skills). */
  targetRoot: string;
  /** Replace an existing skill with the same id. */
  force?: boolean;
  /** Project workspace whose active Agent runs must be excluded during installation. */
  guardWorkspace?: string;
  /** Global installs use a cross-process lease but do not acquire a project guard. */
  global?: boolean;
};

/**
 * Imports a SKILL.md file (or a directory containing one) into targetRoot.
 * Returns the created skill directory.
 */
export function importExternalSkill(
  sourcePath: string,
  opts: ImportSkillOptions,
): { dir: string; skill: ParsedExternalSkill } {
  let file = sourcePath;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new Error(`skill source not found: ${sourcePath}`);
  }
  if (stat.isSymbolicLink()) throw new Error(`skill source must not be a symbolic link: ${sourcePath}`);
  if (stat.isDirectory()) {
    file = path.join(file, "SKILL.md");
  }
  try {
    const fileStat = fs.lstatSync(file);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error("not a regular file");
  } catch {
    throw new Error(`skill source not found: ${file}`);
  }
  const parsed = parseFrontmatterSkill(readUtf8FileBoundedSync(file, MAX_SKILL_DEFINITION_BYTES));
  const meta: Omit<Skill, "scope" | "content"> = {
    apiVersion: 1,
    id: parsed.id,
    name: parsed.name,
    description: parsed.description,
    tags: parsed.tags,
    triggers: parsed.triggers,
    negativeTriggers: [],
    taskTypes: [],
    priority: 50,
    enabled: true,
    // Imported skills default to medium trust (docs/14 §7).
    risk: "medium",
    dependsOn: [],
    conflictsWith: [],
    order: 0,
  };
  const install = (): { dir: string; skill: ParsedExternalSkill } => {
    const rootStat = fs.lstatSync(opts.targetRoot, { throwIfNoEntry: false });
    if (rootStat === undefined) throw new Error(`skills target root must already exist: ${opts.targetRoot}`);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error(`skills target root must be a physical directory: ${opts.targetRoot}`);
    }
    const root = fs.realpathSync(opts.targetRoot);
    const dir = path.join(root, parsed.id);
    const existed = fs.existsSync(dir);
    if (existed && !opts.force) throw new Error(`skill already exists: ${dir} (use --force to replace)`);
    if (existed) {
      const existing = fs.lstatSync(dir);
      if (existing.isSymbolicLink() || !existing.isDirectory() || fs.realpathSync(dir) !== dir) {
        throw new Error(`existing skill directory must be physical: ${dir}`);
      }
    }
    const temp = path.join(root, `.import-${parsed.id}-${randomUUID()}`);
    const backup = path.join(root, `.backup-${parsed.id}-${randomUUID()}`);
    fs.mkdirSync(temp, { mode: 0o700 });
    try {
      fs.writeFileSync(path.join(temp, "skill.json"), `${JSON.stringify(meta, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      fs.writeFileSync(path.join(temp, "SKILL.md"), `${parsed.body}\n`, { flag: "wx", mode: 0o600 });
      if (existed) fs.renameSync(dir, backup);
      try {
        fs.renameSync(temp, dir);
      } catch (error) {
        if (existed && fs.existsSync(backup)) fs.renameSync(backup, dir);
        throw error;
      }
      try {
        fs.rmSync(backup, { recursive: true, force: true });
      } catch {
        // The new installation is already committed. A hidden stale backup is
        // safer than reporting the successful replacement as failed.
      }
      return { dir, skill: parsed };
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  };

  if (opts.guardWorkspace) return withSkillMutation(opts.guardWorkspace, opts.global === true, install);
  return install();
}
