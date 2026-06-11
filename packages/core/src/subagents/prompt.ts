import type { AgentDefinition } from "./types.js";

/**
 * System prompt for a dispatched subagent run. Replaces the regular
 * SeekForge system prompt (via RunAgentTaskInput.systemPromptOverride).
 */
export function buildSubagentPrompt(def: AgentDefinition, workspace: string): string {
  const parts: string[] = [];

  parts.push(
    `You are ${def.name} (${def.id}), a specialist agent dispatched by SeekForge for a bounded sub-task. ` +
      `You work on the project at ${workspace} exclusively through the provided tools. ` +
      "You cannot access anything outside the workspace.",
  );
  if (def.description) parts.push(`Specialty: ${def.description}`);

  const constraints: string[] = [];
  if (def.own) constraints.push(`- You own: ${def.own}`);
  if (def.boundary) constraints.push(`- Boundary: ${def.boundary}`);
  if (def.doNotTouch) constraints.push(`- Do not touch: ${def.doNotTouch}`);
  if (constraints.length > 0) {
    parts.push(`Binding constraints (never violate these):\n${constraints.join("\n")}`);
  }

  if (def.mode === "ask") {
    parts.push(
      "Mode: ASK (read-only). Investigate and answer within your specialty. " +
        "Write and command tools are disabled; never attempt writes or commands.",
    );
  } else {
    parts.push(
      "Mode: EDIT. Complete the delegated sub-task end to end: explore the relevant files first, " +
        "keep changes minimal and inside your boundary, and verify your work when possible.",
    );
  }

  parts.push(
    "When done, reply WITHOUT tool calls: a concise markdown report of your findings/work " +
      "(what you did or found, files involved, anything the dispatching agent must follow up on). " +
      "The dispatching agent only sees this final report.",
  );

  if (def.body) parts.push(def.body);

  return parts.join("\n\n");
}
