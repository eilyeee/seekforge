/**
 * applyProposal: turns an ACCEPTED evolution proposal into a plain-text,
 * git-diffable change. Refuses anything that was not explicitly accepted
 * by a human (the hard boundary of the evolution module).
 *
 *   agent_rule     → bullet under "## Agent Rules" in AGENTS.md
 *   project_memory → bullet in .seekforge/memory/project.md
 *   skill          → scaffold .seekforge/skills/<id>/ and write SKILL.md
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { formatFactBullet, projectMemoryPath } from "../memory/index.js";
import { createSkillScaffold } from "../skills/index.js";
import { readEvolutionProposal, setEvolutionProposalStatus } from "./store.js";
import type { EvolutionProposal } from "./types.js";
import { readFileIfExists } from "../util/fs.js";

export type ApplyProposalResult = {
  proposal: EvolutionProposal;
  /** The file the change was written to (for review / git diff). */
  changedPath: string;
};

const AGENT_RULES_HEADING_RE = /^##\s+Agent Rules\s*$/;

const AGENTS_MD_TEMPLATE = (bullet: string): string => `# AGENTS.md\n\n## Agent Rules\n\n${bullet}\n`;

/**
 * Appends `- <content>` under the "## Agent Rules" section of AGENTS.md.
 * Creates the file (minimal template) or the section (at the end) when
 * missing; an identical rule line is not duplicated.
 */
function applyAgentRule(workspace: string, content: string): string {
  const file = path.join(workspace, "AGENTS.md");
  // Collapse to a single line so the exact-line dedupe below can never miss and
  // the rule stays a well-formed bullet (mirrors formatFactBullet).
  const bullet = `- ${content.replace(/\s*[\r\n]+\s*/g, " ").trim()}`;
  const existing = readFileIfExists(file);
  if (existing === undefined) {
    fs.writeFileSync(file, AGENTS_MD_TEMPLATE(bullet), "utf8");
    return file;
  }
  const lines = existing.split("\n");
  // Dedupe: the exact rule line already present anywhere in the file.
  if (lines.some((line) => line.trim() === bullet)) return file;

  const headingIdx = lines.findIndex((line) => AGENT_RULES_HEADING_RE.test(line));
  if (headingIdx === -1) {
    const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(file, `${sep}\n## Agent Rules\n\n${bullet}\n`, "utf8");
    return file;
  }
  // Insert after the last non-empty line of the section (before the next ## heading).
  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i] as string)) {
      sectionEnd = i;
      break;
    }
  }
  let insertAt = headingIdx + 1;
  for (let i = headingIdx + 1; i < sectionEnd; i++) {
    if ((lines[i] as string).trim() !== "") insertAt = i + 1;
  }
  lines.splice(insertAt, 0, bullet);
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  return file;
}

/**
 * Appends a `- [convention] <content>` bullet to .seekforge/memory/project.md
 * using the memory module's bullet format; identical lines are not duplicated.
 */
function applyProjectMemory(workspace: string, content: string): string {
  const file = projectMemoryPath(workspace);
  const bullet = formatFactBullet({ type: "convention", content });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = readFileIfExists(file);
  if (existing === undefined) {
    fs.writeFileSync(file, `# Project Memory\n${bullet}\n`, "utf8");
    return file;
  }
  if (existing.split("\n").some((line) => line.trim() === bullet)) return file;
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(file, `${sep}${bullet}\n`, "utf8");
  return file;
}

/**
 * Scaffolds the skill and overwrites SKILL.md with the proposed body. Atomic on
 * failure: if the scaffold or write throws after we started creating the skill
 * directory, the whole directory is removed and the error rethrown. Otherwise a
 * half-built skill dir would survive and every retry would fail `skill_exists`,
 * leaving the accepted proposal permanently stuck.
 */
function applySkill(workspace: string, proposal: EvolutionProposal): string {
  const skillId = proposal.proposal.skillId;
  if (!skillId) {
    throw new Error(`skill proposal ${proposal.id} has no skillId`);
  }
  const skillDir = path.join(workspace, ".seekforge", "skills", skillId);
  if (fs.existsSync(skillDir)) {
    throw new Error("skill_exists");
  }
  try {
    const dir = createSkillScaffold(workspace, skillId);
    const skillMd = path.join(dir, "SKILL.md");
    const content = proposal.proposal.content.endsWith("\n")
      ? proposal.proposal.content
      : `${proposal.proposal.content}\n`;
    fs.writeFileSync(skillMd, content, "utf8");
    return skillMd;
  } catch (error) {
    // Roll back the partially-created skill directory so a retry starts clean.
    fs.rmSync(skillDir, { recursive: true, force: true });
    throw error;
  }
}

export function applyProposal(workspace: string, id: string): ApplyProposalResult {
  const proposal = readEvolutionProposal(workspace, id);
  if (proposal.status !== "accepted") {
    throw new Error(`proposal ${id} must be accepted before apply (status: ${proposal.status})`);
  }

  let changedPath: string;
  switch (proposal.type) {
    case "agent_rule":
      changedPath = applyAgentRule(workspace, proposal.proposal.content);
      break;
    case "project_memory":
      changedPath = applyProjectMemory(workspace, proposal.proposal.content);
      break;
    case "skill":
      changedPath = applySkill(workspace, proposal);
      break;
  }

  const applied = setEvolutionProposalStatus(workspace, id, "applied");
  return { proposal: applied, changedPath };
}
