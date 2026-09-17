import type { HookConfig } from "../hooks/index.js";

/**
 * Where an agent definition was loaded from. "builtin" = shipped with
 * SeekForge; "global" = the user's home or an enabled plugin; "project" = the
 * repository, which is untrusted and may only tighten (see policy.ts).
 */
export type AgentScope = "global" | "project" | "builtin";

/**
 * Claude Code's permission modes, mapped onto SeekForge's approval modes when
 * the agent runs: default → confirm, acceptEdits → acceptEdits,
 * bypassPermissions → auto, plan → read-only (ask), dontAsk → confirm with
 * every prompt answered "no".
 */
export type AgentPermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions" | "dontAsk";

/** Reasoning effort requested for the agent's provider, where it supports one. */
export type AgentEffort = "low" | "medium" | "high" | "max";

/**
 * A specialist subagent definition, loaded from
 * `.seekforge/agents/<id>/AGENT.md` (project) or
 * `~/.seekforge/agents/<id>/AGENT.md` (global), or from Claude Code's flat
 * `.claude/agents/<name>.md` files in either place.
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
  /** Tool names removed after the whitelist is applied. */
  disallowedTools?: string[];
  /** "ask" = read-only governance/review agents; "edit" = executors. */
  mode: "ask" | "edit";
  /** Approval mode for the agent's own tool calls; unset = the parent's. */
  permissionMode?: AgentPermissionMode;
  /** "worktree" = edit in a managed git worktree and return a reviewable diff. */
  isolation?: "worktree";
  /** Skill ids whose bodies are preloaded into the agent prompt (bounded). */
  skills?: string[];
  /** Reasoning effort for the agent's provider. */
  effort?: AgentEffort;
  /** Display color for frontends (a named color or #rrggbb). Never reaches the model. */
  color?: string;
  /**
   * MCP servers whose tools this agent may see — names of servers the host
   * already connected. Unset = every connected server. Never defines a server.
   */
  mcpServers?: string[];
  /** Agent-scoped hooks (preToolUse / postToolUse / subagentStop). Never honored for project agents. */
  hooks?: HookConfig;
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

/** Oversized definitions are skipped; partial frontmatter must never be parsed. */
export const MAX_AGENT_DEFINITION_BYTES = 256 * 1024;

/** Default turn budget for a dispatched subagent run. */
export const DEFAULT_SUBAGENT_MAX_TURNS = 15;
