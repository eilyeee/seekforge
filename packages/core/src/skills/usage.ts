import * as fs from "node:fs";
import * as path from "node:path";
import type { SkillSelection } from "./types.js";

/** Appends one JSONL entry per selection to .seekforge/skills-usage.jsonl. */
export function logSkillUsage(workspace: string, sessionId: string, selections: SkillSelection[]): void {
  if (selections.length === 0) return;
  const dir = path.join(workspace, ".seekforge");
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  const lines = selections
    .map(
      (sel) =>
        JSON.stringify({
          ts,
          sessionId,
          skillId: sel.skill.id,
          scope: sel.skill.scope,
          score: sel.score,
          reason: sel.reason,
        }) + "\n",
    )
    .join("");
  fs.appendFileSync(path.join(dir, "skills-usage.jsonl"), lines);
}
