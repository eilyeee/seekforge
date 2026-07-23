import {
  createSkillScaffold,
  importExternalSkill,
  loadSkills,
  loadSkillsDetailed,
  readSkillEffectiveness,
  repairSkills,
  removeSkill,
  resolveSkillsStoreRoot,
  seekforgeHome,
  setSkillEnabled,
} from "@seekforge/core";
import { t } from "../i18n.js";

export function skillListCommand(): void {
  const loaded = loadSkillsDetailed(process.cwd());
  const skills = loaded.skills;
  if (skills.length === 0) {
    console.log(t("cmd.skill.none"));
    return;
  }
  for (const s of skills) {
    console.log(t("cmd.skill.listLine", { id: s.id, scope: s.scope, description: s.description }));
  }
  for (const diagnostic of loaded.diagnostics) {
    console.error(`warning: skipped skill ${diagnostic.id ?? diagnostic.path}: ${diagnostic.message}`);
  }
}

export function skillStatsCommand(): void {
  const stats = readSkillEffectiveness(process.cwd());
  if (stats.length === 0) {
    console.log("No skill effectiveness data yet.");
    return;
  }
  for (const row of stats) {
    const rate = row.successRate === undefined ? "-" : `${Math.round(row.successRate * 100)}%`;
    const adjustment = row.learnedAdjustment === 0 ? "0.000" : row.learnedAdjustment.toFixed(3);
    console.log(
      `${row.skillId}\tselected=${row.selections}\toutcomes=${row.completedOutcomes}\tsuccess=${rate}\tweight=${adjustment}`,
    );
  }
}

export function skillRepairCommand(opts: { global?: boolean; id?: string }): void {
  try {
    const result = repairSkills(process.cwd(), opts);
    console.log(`Repaired ${result.repaired.length} skill metadata file(s); skipped ${result.skipped.length}.`);
    for (const skipped of result.skipped) console.error(`warning: ${skipped.id}: ${skipped.reason}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
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
  try {
    const workspace = process.cwd();
    const targetRoot = resolveSkillsStoreRoot(opts.global ? seekforgeHome() : workspace, true)!;
    const { dir, skill } = importExternalSkill(sourcePath, {
      targetRoot,
      force: opts.force,
      guardWorkspace: workspace,
      global: opts.global,
    });
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
