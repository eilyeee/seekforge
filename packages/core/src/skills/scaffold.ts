import * as fs from "node:fs";
import * as path from "node:path";

const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

const SKILL_MD_TEMPLATE = `# <skill name>

One-line summary of what this skill helps the agent do.

## When to Use

- <situation where this skill applies>

## Do Not Use When

- <situation where another approach is better>

## Required Context

- <facts or files the agent must gather first>

## Procedure

1. <first step, referencing concrete tools like search_text / read_file>
2. <next step>
3. <verify with run_command>

## Verification

- <how to prove the task is done>

## Common Mistakes

- <pitfall to avoid>
`;

/**
 * Scaffolds .seekforge/skills/<id>/ with skill.json + SKILL.md templates.
 * Throws on an invalid id or when the directory already exists.
 * Returns the created directory path.
 */
export function createSkillScaffold(workspace: string, id: string): string {
  if (!SKILL_ID_RE.test(id)) {
    throw new Error(`invalid skill id "${id}": must match ${SKILL_ID_RE}`);
  }
  const dir = path.join(workspace, ".seekforge", "skills", id);
  if (fs.existsSync(dir)) {
    throw new Error(`skill directory already exists: ${dir}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const skillJson = {
    id,
    name: id,
    description: "",
    tags: [],
    triggers: [],
    priority: 50,
    enabled: true,
    risk: "medium",
  };
  fs.writeFileSync(path.join(dir, "skill.json"), JSON.stringify(skillJson, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "SKILL.md"), SKILL_MD_TEMPLATE);
  return dir;
}
