/**
 * Frontmatter fields shared by SeekForge's AGENT.md and Claude Code agent
 * files: the Claude tool-name map and the parsers for the fields both formats
 * accept. Pure — no I/O, no scope decisions beyond what a field means.
 */
import type { HookConfig, HookEntry } from "../hooks/index.js";
import { isRecord } from "../util/guards.js";
import { frontmatterList, type FrontmatterValue, type ParsedFrontmatter } from "./frontmatter.js";
import type { AgentDefinition, AgentEffort, AgentPermissionMode, AgentScope } from "./types.js";

const LSP_TOOLS = [
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_symbols",
  "lsp_document_symbols",
  "lsp_diagnostics",
  "lsp_call_hierarchy",
  "lsp_type_hierarchy",
  "lsp_code_actions",
  "lsp_apply_code_action",
  "lsp_rename",
  "lsp_format",
] as const;

/** Claude Code tool names (lowercased) → SeekForge builtin tool names. */
const CLAUDE_TOOL_MAP: Record<string, readonly string[]> = {
  read: ["read_file"],
  write: ["write_file"],
  edit: ["apply_patch"],
  multiedit: ["apply_patch"],
  glob: ["glob"],
  grep: ["search_text"],
  ls: ["list_files"],
  bash: ["run_command"],
  bashoutput: ["task_output"],
  killshell: ["task_kill"],
  killbash: ["task_kill"],
  webfetch: ["web_fetch"],
  websearch: ["web_search"],
  notebookedit: ["notebook_edit"],
  notebookread: ["notebook_read"],
  todowrite: ["update_plan"],
  skill: ["read_skill"],
  lsp: LSP_TOOLS,
};

/** SeekForge's own tool names pass through unchanged when listed directly. */
const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "apply_patch",
  "list_files",
  "glob",
  "search_text",
  "repo_map",
  "find_definition",
  "run_command",
  "run_tests",
  "run_user_command",
  "task_output",
  "task_kill",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "git_blame",
  "git_commit",
  "update_plan",
  "detect_project",
  "list_scripts",
  "web_fetch",
  "web_search",
  "notebook_read",
  "notebook_edit",
  "image_analyze",
  "read_skill",
  "search_memory",
  "browser_navigate",
  "browser_snapshot",
  "browser_screenshot",
  "browser_click",
  "browser_fill",
  "browser_press",
  "browser_select",
  "browser_upload",
  "browser_wait_for",
  "browser_console",
  "browser_network",
  "agent_report",
  ...LSP_TOOLS,
]);

const MCP_TOOL_RE = /^mcp__[A-Za-z0-9_-]+$/;

/**
 * One tool name from an agent file → SeekForge names. undefined = no
 * equivalent (the caller reports it as dropped). A scoped specifier such as
 * `Bash(git status:*)` is dropped rather than widened to the whole tool.
 */
export function mapAgentToolName(raw: string): string[] | undefined {
  const name = raw.trim();
  if (name === "") return undefined;
  if (KNOWN_TOOLS.has(name) || MCP_TOOL_RE.test(name)) return [name];
  const mapped = CLAUDE_TOOL_MAP[name.toLowerCase()];
  return mapped ? [...mapped] : undefined;
}

/** Maps a tool list, de-duplicating, and reports the names with no equivalent. */
export function mapAgentToolList(names: readonly string[]): { tools: string[]; dropped: string[] } {
  const tools: string[] = [];
  const dropped: string[] = [];
  for (const raw of names) {
    const mapped = mapAgentToolName(raw);
    if (!mapped) {
      if (raw.trim()) dropped.push(raw.trim());
      continue;
    }
    for (const name of mapped) if (!tools.includes(name)) tools.push(name);
  }
  return { tools, dropped };
}

const PERMISSION_MODES: Record<string, AgentPermissionMode> = {
  default: "default",
  confirm: "default",
  manual: "default",
  acceptedits: "acceptEdits",
  plan: "plan",
  ask: "plan",
  bypasspermissions: "bypassPermissions",
  auto: "bypassPermissions",
  dontask: "dontAsk",
};

/** undefined for an absent/empty value; throws on an unknown mode (a typo must not run looser than written). */
export function parsePermissionMode(raw: string | undefined): AgentPermissionMode | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const mode = PERMISSION_MODES[value.toLowerCase()];
  if (!mode) throw new Error(`invalid subagent permissionMode: ${value}`);
  return mode;
}

/** undefined for absent/"none"; throws on anything else but "worktree". */
export function parseIsolation(raw: string | undefined): "worktree" | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value || value === "none") return undefined;
  if (value !== "worktree") throw new Error(`invalid subagent isolation: ${raw}`);
  return "worktree";
}

const EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "max"]);

/** Unknown efforts are ignored: effort only tunes cost, never permissions. */
export function parseEffort(raw: string | undefined): AgentEffort | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === "xhigh") return "max";
  return value !== undefined && EFFORTS.has(value) ? (value as AgentEffort) : undefined;
}

const NAMED_COLORS: ReadonlySet<string> = new Set([
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "cyan",
]);

/**
 * A closed set, because frontends render the value: anything else (escape
 * sequences, CSS) is ignored rather than passed through.
 */
export function parseColor(raw: string | undefined): string | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (NAMED_COLORS.has(value)) return value;
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(value) ? value : undefined;
}

const MAX_LIST_ENTRIES = 32;
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Server references only: an inline server definition in an agent file is never honored. */
export function parseMcpServerNames(value: FrontmatterValue | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const names: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (MCP_SERVER_NAME_RE.test(name) && !names.includes(name)) names.push(name);
  }
  return names.slice(0, MAX_LIST_ENTRIES);
}

const SKILL_REF_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

export function parseSkillRefs(parsed: Pick<ParsedFrontmatter, "values">): string[] | undefined {
  const list = frontmatterList(parsed, "skills");
  if (list === undefined) return undefined;
  return [...new Set(list.filter((id) => SKILL_REF_RE.test(id)))].slice(0, MAX_LIST_ENTRIES);
}

const MAX_HOOKS_PER_STAGE = 16;
const MAX_HOOK_COMMAND_CHARS = 4096;

/** Hook stages an agent may declare; the others never fire inside a nested run. */
const AGENT_HOOK_STAGES: Record<string, "preToolUse" | "postToolUse" | "subagentStop"> = {
  pretooluse: "preToolUse",
  posttooluse: "postToolUse",
  stop: "subagentStop",
  subagentstop: "subagentStop",
};

/**
 * A Claude Code matcher (`Bash`, `Edit|Write`, `*`) → SeekForge tool names;
 * ["*"] for any tool; undefined when the matcher is a regex we cannot map
 * exactly. Over-matching would run a user's hook on calls it never named.
 */
function mapHookMatcher(raw: string | undefined): string[] | undefined {
  const matcher = raw?.trim() ?? "";
  if (matcher === "" || matcher === "*" || matcher === ".*") return ["*"];
  const out: string[] = [];
  for (const alternative of matcher.split("|")) {
    if (!/^[A-Za-z0-9_]+$/.test(alternative.trim())) return undefined;
    const mapped = mapAgentToolName(alternative);
    if (!mapped) return undefined;
    for (const name of mapped) if (!out.includes(name)) out.push(name);
  }
  return out.length > 0 ? out : undefined;
}

function hookCommand(value: FrontmatterValue | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const command = value.trim();
  return command !== "" && command.length <= MAX_HOOK_COMMAND_CHARS ? command : undefined;
}

/**
 * Agent-scoped hooks in either shape:
 * - SeekForge: `{ preToolUse: [{ match?, pattern?, command }] }`
 * - Claude Code: `{ PreToolUse: [{ matcher?, hooks: [{ type: command, command }] }] }`
 * Stages other than preToolUse / postToolUse / Stop (→ subagentStop) are dropped.
 */
export function parseAgentHooks(value: FrontmatterValue | undefined): HookConfig | undefined {
  if (value === undefined || typeof value === "string" || Array.isArray(value)) return undefined;
  const hooks: HookConfig = {};
  for (const [rawStage, rawEntries] of Object.entries(value)) {
    const stage = AGENT_HOOK_STAGES[rawStage.toLowerCase()];
    if (!stage || !Array.isArray(rawEntries)) continue;
    const entries: HookEntry[] = hooks[stage] ?? [];
    for (const rawEntry of rawEntries) {
      if (!isRecord(rawEntry)) continue;
      const entry = rawEntry as Record<string, FrontmatterValue>;
      if (Array.isArray(entry["hooks"])) {
        const tools = mapHookMatcher(typeof entry["matcher"] === "string" ? entry["matcher"] : undefined);
        if (!tools) continue;
        for (const hook of entry["hooks"]) {
          if (!isRecord(hook)) continue;
          const spec = hook as Record<string, FrontmatterValue>;
          if (spec["type"] !== undefined && spec["type"] !== "command") continue;
          const command = hookCommand(spec["command"]);
          if (!command) continue;
          for (const tool of tools) entries.push({ ...(tool === "*" ? {} : { match: tool }), command });
        }
        continue;
      }
      const command = hookCommand(entry["command"]);
      if (!command) continue;
      const match = typeof entry["match"] === "string" && entry["match"].trim() ? entry["match"].trim() : undefined;
      const pattern = typeof entry["pattern"] === "string" && entry["pattern"] !== "" ? entry["pattern"] : undefined;
      entries.push({ ...(match ? { match } : {}), ...(pattern !== undefined ? { pattern } : {}), command });
    }
    if (entries.length > 0) hooks[stage] = entries.slice(0, MAX_HOOKS_PER_STAGE);
  }
  return Object.keys(hooks).length > 0 ? hooks : undefined;
}

/** First present key among aliases (frontmatter keys are lowercased). */
export function fieldValue(parsed: Pick<ParsedFrontmatter, "values">, ...keys: string[]): FrontmatterValue | undefined {
  for (const key of keys) {
    const value = parsed.values.get(key);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function fieldString(parsed: Pick<ParsedFrontmatter, "values">, ...keys: string[]): string | undefined {
  const value = fieldValue(parsed, ...keys);
  return typeof value === "string" ? value : undefined;
}

/** A list field under any alias, e.g. `disallowedTools` / `disallowed-tools`. */
export function fieldList(parsed: Pick<ParsedFrontmatter, "values">, ...keys: string[]): string[] | undefined {
  for (const key of keys) {
    const list = frontmatterList(parsed, key);
    if (list !== undefined) return list;
  }
  return undefined;
}

export type ExtendedAgentFields = Pick<
  AgentDefinition,
  "disallowedTools" | "permissionMode" | "isolation" | "skills" | "effort" | "color" | "mcpServers" | "hooks"
>;

/**
 * The fields both formats share beyond the historical set. `mapTools` maps
 * disallowedTools through the Claude name map (external files); hooks are
 * dropped for project scope, which may not run commands.
 */
export function parseExtendedAgentFields(
  parsed: Pick<ParsedFrontmatter, "values">,
  scope: AgentScope | "external",
): ExtendedAgentFields {
  const disallowedRaw = fieldList(parsed, "disallowedtools", "disallowed-tools", "disallowed_tools");
  const disallowedTools =
    disallowedRaw === undefined
      ? undefined
      : disallowedRaw.flatMap((name) => mapAgentToolName(name) ?? []).filter((n, i, all) => all.indexOf(n) === i);
  const permissionMode = parsePermissionMode(fieldString(parsed, "permissionmode", "permission-mode"));
  const isolation = parseIsolation(fieldString(parsed, "isolation"));
  const skills = parseSkillRefs(parsed);
  const effort = parseEffort(fieldString(parsed, "effort"));
  const color = parseColor(fieldString(parsed, "color"));
  const mcpServers = parseMcpServerNames(fieldValue(parsed, "mcpservers", "mcp-servers", "mcp_servers"));
  const hooks = scope === "project" ? undefined : parseAgentHooks(fieldValue(parsed, "hooks"));
  return {
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(color !== undefined ? { color } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
  };
}
