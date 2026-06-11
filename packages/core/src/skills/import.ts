import * as fs from "node:fs";
import * as path from "node:path";
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

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function kebabize(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Minimal YAML-frontmatter reader for the subset external skills use:
 * `key: value`, quoted values, and `key: |` block scalars. Lists and
 * nested maps are ignored (we only need name/description/trigger/tags).
 */
export function parseFrontmatterSkill(markdown: string): ParsedExternalSkill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown);
  if (!m) {
    throw new Error("not an importable skill: missing YAML frontmatter (--- ... ---)");
  }
  const [, fm, body] = m as unknown as [string, string, string];

  const fields = new Map<string, string>();
  const lines = fm.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = (kv[1] as string).toLowerCase();
    let value = (kv[2] as string).trim();
    if (value === "|" || value === ">") {
      // Block scalar: consume the indented lines that follow.
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1] as string) || (lines[i + 1] as string).trim() === "")) {
        i++;
        block.push((lines[i] as string).trim());
      }
      value = block.join(" ").trim();
    }
    value = value.replace(/^["']|["']$/g, "");
    fields.set(key, value);
  }

  const rawName = fields.get("name") ?? "";
  const id = kebabize(rawName);
  if (!ID_RE.test(id)) {
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
export function importExternalSkill(sourcePath: string, opts: ImportSkillOptions): { dir: string; skill: ParsedExternalSkill } {
  let file = sourcePath;
  const stat = fs.statSync(file);
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
