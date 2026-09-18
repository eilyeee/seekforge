/**
 * Deterministic task routing for interactive chat surfaces.
 *
 * This deliberately classifies only the execution *shape*, never the safety
 * policy. An explicit ask/edit choice always wins. Auto mode errs toward an
 * answer when the user did not ask for a mutation, so a conversational prompt
 * cannot unexpectedly start an edit workflow.
 */

export type TaskProfile = "conversation" | "inspection" | "quick-edit" | "implementation";
export type RequestedTaskMode = "auto" | "ask" | "edit";

export type TaskExecution = {
  mode: "ask" | "edit";
  profile: TaskProfile;
};

const MUTATION_RE =
  /\b(?:add|build|change|create|delete|edit|fix|implement|install|make|modify|refactor|remove|rename|replace|update|write)\b|(?:修复|修改|改掉|实现|新增|添加|删除|重构|迁移|替换|创建|写入|开发|优化|安装|全做|都做|全部做|做完|搞定)/iu;
const INSPECTION_RE = /\b(?:audit|check|inspect|review|run|test|verify)\b|(?:检查|查看|审查|测试|运行|执行|验证)/iu;
const COMPLEX_RE =
  /\b(?:across|all|architecture|audit|complex|end[- ]to[- ]end|migration|multiple|redesign|system[- ]wide)\b|(?:全部|全做|都做|多个|复杂|全面|架构|迁移|系统性|端到端)/iu;
const MULTI_PART_RE = /(?:\b(?:and|also|then|plus)\b|[;；]|\n\s*(?:[-*]|\d+[.)])|(?:并且|同时|然后|以及))/iu;

/**
 * Resolve an interactive request into its safe mode and the smallest useful
 * tool/prompt profile. `auto` is intentionally available to UI adapters only;
 * the actual AgentCore run still receives the established ask/edit contract.
 */
export function resolveTaskExecution(task: string, requested: RequestedTaskMode, plan = false): TaskExecution {
  if (plan) return { mode: "ask", profile: "inspection" };
  if (requested === "ask") return { mode: "ask", profile: "inspection" };
  if (requested === "edit") return { mode: "edit", profile: "implementation" };

  const trimmed = task.trim();
  if (!MUTATION_RE.test(trimmed)) {
    return { mode: "ask", profile: INSPECTION_RE.test(trimmed) ? "inspection" : "conversation" };
  }

  const wordCount = trimmed.split(/\s+/u).filter(Boolean).length;
  const complex = COMPLEX_RE.test(trimmed) || MULTI_PART_RE.test(trimmed) || wordCount >= 36 || trimmed.length >= 180;
  return { mode: "edit", profile: complex ? "implementation" : "quick-edit" };
}

/** Built-in tools useful for a concise codebase answer, without side effects. */
const CONVERSATION_TOOLS = [
  "list_files",
  "read_file",
  "search_text",
  "glob",
  "git_status",
  "git_diff",
  "git_log",
  "git_blame",
  "git_show",
  "detect_project",
  "list_scripts",
  "repo_map",
  "find_definition",
  "ask_user",
] as const;

/** Read-only investigation keeps shell access for the policy's safe L0 probes. */
const INSPECTION_TOOLS = [...CONVERSATION_TOOLS, "run_command"] as const;

/** The normal coding loop, omitting expensive/specialist integrations until needed. */
const QUICK_EDIT_TOOLS = [
  ...CONVERSATION_TOOLS,
  "write_file",
  "apply_patch",
  "run_command",
  "run_tests",
  "task_output",
  "task_kill",
  "update_plan",
] as const;

/**
 * Returns the exact model-visible catalog for a profile. `undefined` retains
 * the complete dispatcher, including explicitly configured MCP/plugin tools.
 */
export function toolsForTaskProfile(profile: TaskProfile): readonly string[] | undefined {
  if (profile === "conversation") return CONVERSATION_TOOLS;
  if (profile === "inspection") return INSPECTION_TOOLS;
  if (profile === "quick-edit") return QUICK_EDIT_TOOLS;
  return undefined;
}

/**
 * An explicitly supplied allow-list is a security boundary, so profile routing
 * can only narrow it. It must never re-introduce a tool the caller hid.
 */
export function allowedToolsForTaskProfile(
  profile: TaskProfile,
  explicitAllowedTools: readonly string[] | undefined,
): string[] | undefined {
  const profileTools = toolsForTaskProfile(profile);
  if (profileTools === undefined) return explicitAllowedTools ? [...explicitAllowedTools] : undefined;
  if (explicitAllowedTools === undefined) return [...profileTools];
  const allowed = new Set(explicitAllowedTools);
  return profileTools.filter((name) => allowed.has(name));
}
