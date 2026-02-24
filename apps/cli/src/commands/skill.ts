import { createSkillScaffold, loadSkills } from "@seekforge/core";

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
