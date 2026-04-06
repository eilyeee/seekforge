import { homedir } from "node:os";
import { join } from "node:path";
import {
  createSkillScaffold,
  importExternalSkill,
  loadSkills,
  removeSkill,
  setSkillEnabled,
} from "@seekforge/core";

export function skillListCommand(): void {
  const skills = loadSkills(process.cwd());
  if (skills.length === 0) {
    console.log("No skills available.");
    return;
  }
  for (const s of skills) {
    console.log(`${s.id}  [${s.scope}]  ${s.description}`);
  }
}

export function skillShowCommand(id: string): void {
  const skill = loadSkills(process.cwd()).find((s) => s.id === id);
  if (!skill) {
    console.error(`Skill "${id}" not found. See \`seekforge skill list\`.`);
    process.exitCode = 1;
    return;
  }
  console.log(`# ${skill.name} [${skill.scope}]`);
  console.log(`tags: ${skill.tags.join(", ")}   triggers: ${skill.triggers.join(", ")}`);
  console.log("");
  console.log(skill.content);
}

export function skillImportCommand(
  sourcePath: string,
  opts: { global?: boolean; force?: boolean },
): void {
  const targetRoot = opts.global
    ? join(homedir(), ".seekforge", "skills")
    : join(process.cwd(), ".seekforge", "skills");
  try {
    const { dir, skill } = importExternalSkill(sourcePath, { targetRoot, force: opts.force });
    console.log(`imported "${skill.id}" → ${dir}`);
    if (skill.triggers.length > 0) {
      console.log(`triggers: ${skill.triggers.slice(0, 8).join(", ")}${skill.triggers.length > 8 ? ", …" : ""}`);
    }
    console.log(`Check it with \`seekforge skill show ${skill.id}\`. Imported skills are`);
    console.log("procedure suggestions only — they never grant extra permissions.");
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

export function skillCreateCommand(id: string): void {
  try {
    const dir = createSkillScaffold(process.cwd(), id);
    console.log(`created ${dir}`);
    console.log("Edit SKILL.md and skill.json, then check with `seekforge skill show " + id + "`.");
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

export function skillEnableCommand(id: string, opts: { global?: boolean }): void {
  try {
    const res = setSkillEnabled(process.cwd(), id, true, { global: opts.global });
    const scope = opts.global ? "global" : "project";
    console.log(`enabled "${res.id}" (${scope})`);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

export function skillDisableCommand(id: string, opts: { global?: boolean }): void {
  try {
    const res = setSkillEnabled(process.cwd(), id, false, { global: opts.global });
    const scope = opts.global ? "global" : "project";
    const how = res.action === "marker" ? ` (override marker at ${res.path})` : "";
    console.log(`disabled "${res.id}" (${scope})${how}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

export function skillRemoveCommand(id: string, opts: { global?: boolean }): void {
  try {
    const res = removeSkill(process.cwd(), id, { global: opts.global });
    console.log(`removed "${res.id}" (${res.path})`);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
