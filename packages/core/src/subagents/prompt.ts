import { DEFAULT_SUBAGENT_MAX_TURNS, type AgentDefinition } from "./types.js";

/**
 * System prompt for a dispatched subagent run. Replaces the regular
 * SeekForge system prompt (via RunAgentTaskInput.systemPromptOverride).
 */
export function buildSubagentPrompt(def: AgentDefinition, workspace: string): string {
  const parts: string[] = [];

  parts.push(
    `You are ${def.name} (${def.id}), a specialist agent dispatched by a parent SeekForge agent for a bounded sub-task. ` +
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

  const maxTurns = def.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS;
  parts.push(
    `Budget: at most ${maxTurns} turns of tool calls. Spend them on the calls that matter; ` +
      "do not burn turns on ritual orientation or re-reading what you already know.",
  );

  parts.push(
    "You cannot ask questions: ask_user is unavailable in nested runs and no human reads your output mid-task. " +
      "Never attempt it. If the task is ambiguous, state your assumption in the report and proceed.",
  );

  parts.push(
    "When done, reply WITHOUT tool calls: a concise markdown report. It is consumed by the parent agent " +
      "(a machine, not a human), and every line occupies the parent's context. Lead with the answer or outcome, " +
      "then structured bullets (what you did or found, files involved, anything the parent must follow up on). " +
      "Stay under ~400 words unless the task genuinely demands more. The parent only sees this final report.",
  );

  if (def.body) parts.push(def.body);

  return parts.join("\n\n");
}
