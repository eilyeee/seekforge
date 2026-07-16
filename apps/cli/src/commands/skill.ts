import { homedir } from "node:os";
import { join } from "node:path";
import { createSkillScaffold, importExternalSkill, loadSkills, removeSkill, setSkillEnabled } from "@seekforge/core";
import { t } from "../i18n.js";

export function skillListCommand(): void {
  const skills = loadSkills(process.cwd());
  if (skills.length === 0) {
    console.log(t("cmd.skill.none"));
    return;
  }
  for (const s of skills) {
    console.log(t("cmd.skill.listLine", { id: s.id, scope: s.scope, description: s.description }));
  }
}

export function skillShowCommand(id: string): void {
  const skill = loadSkills(process.cwd()).find((s) => s.id === id);
  if (!skill) {
    console.error(t("err.skillNotFound", { id }));
    process.exitCode = 1;
    return;
  }
  console.log(`# ${skill.name} [${skill.scope}]`);
  console.log(`tags: ${skill.tags.join(", ")}   triggers: ${skill.triggers.join(", ")}`);
  console.log("");
  console.log(skill.content);
}

export function skillImportCommand(sourcePath: string, opts: { global?: boolean; force?: boolean }): void {
  const targetRoot = opts.global
    ? join(homedir(), ".seekforge", "skills")
    : join(process.cwd(), ".seekforge", "skills");
  try {
    const { dir, skill } = importExternalSkill(sourcePath, { targetRoot, force: opts.force });
    console.log(t("cmd.skill.imported", { id: skill.id, dir }));
    if (skill.triggers.length > 0) {
      const triggers = skill.triggers.slice(0, 8).join(", ") + (skill.triggers.length > 8 ? ", …" : "");
      console.log(t("cmd.skill.importedTriggers", { triggers }));
    }
    console.log(t("cmd.skill.importedMore", { id: skill.id }));
    console.log(t("cmd.skill.importedMore2"));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

export function skillCreateCommand(id: string): void {
  try {
    const dir = createSkillScaffold(process.cwd(), id);
    console.log(t("cmd.skill.created", { dir }));
    console.log(t("cmd.skill.createdMore", { id }));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

export function skillEnableCommand(id: string, opts: { global?: boolean }): void {
  try {
    const res = setSkillEnabled(process.cwd(), id, true, { global: opts.global });
    const scope = opts.global ? "global" : "project";
    console.log(t("cmd.skill.enabled", { id: res.id, scope }));
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
    console.log(t("cmd.skill.disabled", { id: res.id, scope, marker: how }));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

export function skillRemoveCommand(id: string, opts: { global?: boolean }): void {
  try {
    const res = removeSkill(process.cwd(), id, { global: opts.global });
    console.log(t("cmd.skill.removed", { id: res.id, path: res.path }));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
