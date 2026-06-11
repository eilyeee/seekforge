/** Where an agent definition was loaded from. "builtin" = shipped with SeekForge. */
export type AgentScope = "global" | "project" | "builtin";

/**
 * A specialist subagent definition, loaded from
 * `.seekforge/agents/<id>/AGENT.md` (project) or
 * `~/.seekforge/agents/<id>/AGENT.md` (global).
 */
export type AgentDefinition = {
  /** kebab-case identifier (the directory name). */
  id: string;
  name: string;
  description: string;
  /** Dispatch hints; informational (the model decides). */
  triggers: string[];
  /** Tool-name whitelist; undefined = all tools (minus dispatch_agent). */
  tools?: string[];
  /** "ask" = read-only governance/review agents; "edit" = executors. */
  mode: "ask" | "edit";
  /** What this agent owns (binding constraint in its prompt). */
  own?: string;
  /** What this agent must never touch. */
  doNotTouch?: string;
  /** One-line boundary statement. */
  boundary?: string;
  /** Turn budget for the nested run. Default 15. */
  maxTurns?: number;
  /** Model override for this agent's runs (AgentCoreDeps.providerForModel). */
  model?: string;
  scope: AgentScope;
  /** AGENT.md markdown body, appended to the subagent system prompt. */
  body?: string;
};

/** Default turn budget for a dispatched subagent run. */
export const DEFAULT_SUBAGENT_MAX_TURNS = 15;
