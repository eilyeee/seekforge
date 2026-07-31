import { createHash } from "node:crypto";
import type { SkillSupplyChainEntry } from "@seekforge/shared";
import { CURRENT_SKILL_API_VERSION, loadSkillsDetailed } from "./load.js";

export function skillSupplyChainReport(workspace: string): {
  generatedAt: string;
  entries: SkillSupplyChainEntry[];
  diagnostics: ReturnType<typeof loadSkillsDetailed>["diagnostics"];
} {
  const loaded = loadSkillsDetailed(workspace);
  const entries = loaded.skills.map((skill): SkillSupplyChainEntry => {
    const canonical = JSON.stringify({
      apiVersion: skill.apiVersion ?? CURRENT_SKILL_API_VERSION,
      id: skill.id,
      scope: skill.scope,
      name: skill.name,
      description: skill.description,
      tags: skill.tags,
      triggers: skill.triggers,
      negativeTriggers: skill.negativeTriggers,
      taskTypes: skill.taskTypes,
      appliesTo: skill.appliesTo,
      priority: skill.priority,
      risk: skill.risk,
      dependsOn: skill.dependsOn,
      conflictsWith: skill.conflictsWith,
      order: skill.order,
      content: skill.content,
    });
    return {
      id: skill.id,
      scope: skill.scope,
      apiVersion: skill.apiVersion ?? CURRENT_SKILL_API_VERSION,
      digest: createHash("sha256").update(canonical).digest("hex"),
      integrity: "valid",
      risk: skill.risk,
      dependencies: [...(skill.dependsOn ?? [])],
      conflicts: [...(skill.conflictsWith ?? [])],
    };
  });
  return { generatedAt: new Date().toISOString(), entries, diagnostics: loaded.diagnostics };
}
