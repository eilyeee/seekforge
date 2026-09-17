/**
 * Creating a new agent definition file (`<root>/.seekforge/agents/<id>/AGENT.md`)
 * from a few fields, for interactive surfaces that offer "new agent". The file
 * is rendered in the canonical format the loader parses, round-tripped through
 * that parser before it is written, and written through the workspace-state
 * writer, which refuses symlinked parents.
 */

import { join } from "node:path";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { AGENT_ID_RE } from "./frontmatter.js";
import { renderAgentMarkdown } from "./import.js";
import { MAX_AGENT_DEFINITION_BYTES, parseAgentMarkdown } from "./load.js";

export const MAX_AGENT_ID_CHARS = 64;

export type NewAgentDefinition = {
  id: string;
  description: string;
  mode: "ask" | "edit";
  /** Tool-name whitelist; omitted = every tool. */
  tools?: string[];
  model?: string;
  /** Markdown appended to the agent's system prompt. */
  body?: string;
};

/** Where an agent's definition lives, relative to its root (workspace or SeekForge home). */
export function agentDefinitionRelPath(id: string): string {
  return `.seekforge/agents/${id}/AGENT.md`;
}

/** Why `input` cannot become an agent file, or undefined when it can. */
export function validateNewAgent(input: NewAgentDefinition): string | undefined {
  if (!AGENT_ID_RE.test(input.id) || input.id.length > MAX_AGENT_ID_CHARS) {
    return `agent id must be lowercase letters, digits and dashes (max ${MAX_AGENT_ID_CHARS}): ${JSON.stringify(input.id)}`;
  }
  if (input.description.trim() === "") return "agent description must not be empty";
  if (input.mode !== "ask" && input.mode !== "edit") return 'agent mode must be "ask" or "edit"';
  if (input.tools?.some((tool) => !/^[A-Za-z0-9_:*.-]+$/.test(tool)))
    return "tool names may not contain spaces or commas";
  return undefined;
}

/**
 * Writes a new AGENT.md under `root` and returns its path. Throws when the input
 * is invalid or an agent with that id already exists in this root.
 */
export function createAgentDefinition(root: string, input: NewAgentDefinition): string {
  const problem = validateNewAgent(input);
  if (problem) throw new Error(problem);
  const rel = agentDefinitionRelPath(input.id);
  if (readWorkspaceStateFile(root, rel, MAX_AGENT_DEFINITION_BYTES) !== undefined) {
    throw new Error(`agent "${input.id}" already exists: ${rel}`);
  }
  const description = input.description.replace(/\s+/g, " ").trim();
  const model = input.model?.trim();
  const markdown = renderAgentMarkdown({
    id: input.id,
    name: input.id,
    description,
    triggers: [],
    mode: input.mode,
    ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
    ...(model ? { model } : {}),
    body:
      input.body?.trim() ||
      `You are the ${input.id} agent. ${description}\n\nDescribe how this agent should work here.`,
  });
  // The loader is the judge of what a definition means; never write a file it would reject.
  parseAgentMarkdown("project", input.id, markdown);
  writeWorkspaceStateFileAtomic(root, rel, markdown);
  return join(root, rel);
}
