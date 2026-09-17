/**
 * How a definition's fields become a nested run's configuration, and the one
 * place that enforces the trust rule for repository-controlled agents: a
 * project agent may only TIGHTEN what its parent run already has.
 */
import type { ApprovalMode, ToolDefinitionForModel } from "@seekforge/shared";
import type { HookConfig, HookEntry, HookStage } from "../hooks/index.js";
import type { Skill } from "../skills/types.js";
import type { AgentDefinition, AgentEffort } from "./types.js";

export type AgentRunPolicy = {
  mode: "ask" | "edit";
  approvalMode: ApprovalMode;
  /** dontAsk: every permission prompt of the nested run is answered "no". */
  denyPrompts: boolean;
  /** Set when a project agent asked for a looser mode than its parent has. */
  clampedFrom?: ApprovalMode;
};

/** How much an approval mode runs without asking; higher = looser. */
const LOOSENESS: Record<ApprovalMode, number> = { manual: 0, confirm: 0, acceptEdits: 1, auto: 2 };

function declaredApprovalMode(def: AgentDefinition, parent: ApprovalMode): ApprovalMode {
  switch (def.permissionMode) {
    case "default":
    case "dontAsk":
      return "confirm";
    case "acceptEdits":
      return "acceptEdits";
    case "bypassPermissions":
      return "auto";
    default:
      return parent;
  }
}

/**
 * The nested run's mode and approval mode. Builtin, global (user) and plugin
 * definitions get what they declare; a project definition is clamped to its
 * parent's approval mode whenever it declares a looser one.
 */
export function resolveAgentRunPolicy(
  def: AgentDefinition,
  parent: { mode: "ask" | "edit"; approvalMode: ApprovalMode },
): AgentRunPolicy {
  const mode = def.permissionMode === "plan" ? "ask" : def.mode;
  const declared = declaredApprovalMode(def, parent.approvalMode);
  const denyPrompts = def.permissionMode === "dontAsk";
  if (def.scope === "project" && LOOSENESS[declared] > LOOSENESS[parent.approvalMode]) {
    return { mode, approvalMode: parent.approvalMode, denyPrompts, clampedFrom: declared };
  }
  return { mode, approvalMode: declared, denyPrompts };
}

/**
 * Whether an MCP tool comes from `server`. Names can be hashed
 * (`mcp__<prefix>__<tool>__<digest>`), so the description prefix the MCP
 * adapter writes (`[MCP:<server>]`) is the authority, and the name must agree
 * with it so a server whose name merely starts like another cannot pass.
 */
function isToolOfServer(tool: ToolDefinitionForModel, server: string): boolean {
  if (!tool.name.startsWith("mcp__")) return false;
  const marker = `[MCP:${server}]`;
  if (tool.description !== marker && !tool.description.startsWith(`${marker} `)) return false;
  const segment = server
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 15);
  return tool.name.startsWith(`mcp__${server}__`) || tool.name.startsWith(`mcp__${segment}__`);
}

/**
 * The tool names a nested run may use, or undefined when the definition does
 * not narrow the parent's set. Only ever a subset of `available` — the
 * parent's own (already allow-listed) tools — so no definition, trusted or
 * not, can grant a tool its parent does not have.
 */
export function resolveAgentTools(
  def: AgentDefinition,
  available: readonly ToolDefinitionForModel[],
): string[] | undefined {
  if (def.tools === undefined && def.mcpServers === undefined && def.disallowedTools === undefined) return undefined;
  const servers = def.mcpServers;
  const fromServers = (tool: ToolDefinitionForModel): boolean =>
    servers?.some((server) => isToolOfServer(tool, server)) === true;
  let allowed: Set<string>;
  if (def.tools !== undefined) {
    allowed = new Set(def.tools);
    for (const tool of available) if (fromServers(tool)) allowed.add(tool.name);
  } else {
    allowed = new Set(
      available
        .filter((tool) => servers === undefined || !tool.name.startsWith("mcp__") || fromServers(tool))
        .map((tool) => tool.name),
    );
  }
  for (const name of def.disallowedTools ?? []) allowed.delete(name);
  const present = new Set(available.map((tool) => tool.name));
  return [...allowed].filter((name) => present.has(name));
}

const AGENT_HOOK_STAGES: readonly HookStage[] = ["preToolUse", "postToolUse", "subagentStop"];

/**
 * The hooks a nested run fires: the parent's, then the definition's own.
 * Project definitions never contribute hooks — a repository must not be able
 * to run a command because an agent file said so.
 */
export function resolveAgentHooks(def: AgentDefinition, parent: HookConfig | undefined): HookConfig | undefined {
  if (def.scope === "project" || def.hooks === undefined) return parent;
  const merged: HookConfig = { ...(parent ?? {}) };
  for (const stage of AGENT_HOOK_STAGES) {
    const own = def.hooks[stage] as HookEntry[] | undefined;
    if (!own?.length) continue;
    (merged[stage] as HookEntry[] | undefined) = [...((parent?.[stage] as HookEntry[] | undefined) ?? []), ...own];
  }
  return merged;
}

/**
 * Provider overrides for a definition's effort; undefined leaves the provider
 * as configured. "low" turns thinking off and clears any configured effort.
 */
export function effortProviderOptions(
  effort: AgentEffort | undefined,
): { thinking: boolean; reasoningEffort: "high" | "max" | undefined } | undefined {
  switch (effort) {
    case "low":
      return { thinking: false, reasoningEffort: undefined };
    case "medium":
    case "high":
      return { thinking: true, reasoningEffort: "high" };
    case "max":
      return { thinking: true, reasoningEffort: "max" };
    default:
      return undefined;
  }
}

/** Upper bound on preloaded skill text in one agent prompt. */
export const SUBAGENT_SKILLS_MAX_CHARS = 12_000;

/**
 * The bodies of the definition's `skills`, in order, within
 * {@link SUBAGENT_SKILLS_MAX_CHARS}. A skill that does not fit is cut with a
 * pointer to read_skill; unknown or disabled ids are named, not guessed at.
 */
export function buildPreloadedSkills(ids: readonly string[] | undefined, skills: readonly Skill[]): string | undefined {
  if (!ids || ids.length === 0) return undefined;
  const byId = new Map(skills.filter((skill) => skill.enabled).map((skill) => [skill.id, skill]));
  const parts: string[] = [];
  const missing: string[] = [];
  let remaining = SUBAGENT_SKILLS_MAX_CHARS;
  for (const id of ids) {
    const skill = byId.get(id);
    if (!skill) {
      missing.push(id);
      continue;
    }
    const heading = `### Skill: ${skill.id}\n`;
    const body = skill.content.trim();
    if (remaining <= heading.length + 80) {
      parts.push(`### Skill: ${skill.id}\n(not preloaded — call read_skill("${skill.id}"))`);
      continue;
    }
    const room = remaining - heading.length;
    const text =
      body.length <= room
        ? body
        : `${body.slice(0, room - 80).trimEnd()}\n…[truncated — call read_skill("${skill.id}") for the rest]`;
    parts.push(heading + text);
    remaining -= heading.length + text.length;
  }
  if (missing.length > 0) parts.push(`(Unavailable skills, not preloaded: ${missing.join(", ")})`);
  return parts.length > 0 ? `## Preloaded skills\n\n${parts.join("\n\n")}` : undefined;
}
