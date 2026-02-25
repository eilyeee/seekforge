import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "../../src/skills/index.js";

export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-skills-"));
}

/** Writes <root>/<dirName>/skill.json + SKILL.md (either part optional). */
export function writeSkillDir(
  root: string,
  dirName: string,
  json: unknown | undefined,
  md: string | undefined,
): string {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  if (json !== undefined) {
    const body = typeof json === "string" ? json : JSON.stringify(json, null, 2);
    fs.writeFileSync(path.join(dir, "skill.json"), body);
  }
  if (md !== undefined) {
    fs.writeFileSync(path.join(dir, "SKILL.md"), md);
  }
  return dir;
}

export function skillJson(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id,
    description: `description of ${id}`,
    tags: [],
    triggers: [],
    ...overrides,
  };
}

export function makeSkill(id: string, overrides: Partial<Skill> = {}): Skill {
  return {
    id,
    scope: "builtin",
    name: id,
    description: `description of ${id}`,
    tags: [],
    triggers: [],
    priority: 50,
    enabled: true,
    risk: "low",
    content: `# ${id}\n\n## Procedure\n\n1. do the thing for ${id}\n\n## Verification\n\n- done\n`,
    ...overrides,
  };
}
