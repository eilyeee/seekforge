import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_ID_RE, kebabize, parseFrontmatter } from "../subagents/frontmatter.js";
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
  if (!AGENT_ID_RE.test(id)) {
    throw new Error(`not an importable skill: frontmatter "name" is missing or invalid (${rawName || "empty"})`);
  }

  const description = (fields.get("description") ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  const triggers = (fields.get("trigger") ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  const tags = (fields.get("tags") ?? "")
    .split(/[,|]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  return { id, name: rawName.trim(), description, triggers, tags, body: body.trim() };
}

export type ImportSkillOptions = {
  /** Skills root to write into (e.g. <ws>/.seekforge/skills or ~/.seekforge/skills). */
  targetRoot: string;
  /** Replace an existing skill with the same id. */
  force?: boolean;
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
    stat = fs.statSync(file);
  } catch {
    throw new Error(`skill source not found: ${sourcePath}`);
  }
  if (stat.isDirectory()) {
    file = path.join(file, "SKILL.md");
  }
  const parsed = parseFrontmatterSkill(fs.readFileSync(file, "utf8"));

  const dir = path.join(opts.targetRoot, parsed.id);
  if (fs.existsSync(dir) && !opts.force) {
    throw new Error(`skill already exists: ${dir} (use --force to replace)`);
  }
  fs.mkdirSync(dir, { recursive: true });

  const meta: Omit<Skill, "scope" | "content"> = {
    id: parsed.id,
    name: parsed.name,
    description: parsed.description,
    tags: parsed.tags,
    triggers: parsed.triggers,
    priority: 50,
    enabled: true,
    // Imported skills default to medium trust (docs/14 §7).
    risk: "medium",
  };
  fs.writeFileSync(path.join(dir, "skill.json"), `${JSON.stringify(meta, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "SKILL.md"), `${parsed.body}\n`);
  return { dir, skill: parsed };
}
