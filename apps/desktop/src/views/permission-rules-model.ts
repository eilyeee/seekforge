/**
 * Pure model for the permission-rules editor. The server validates again (and
 * its layer owner decides what a load keeps); this only shapes form input and
 * mirrors the one scope rule the UI has to explain up front.
 */
import type { PermissionRule } from "@seekforge/shared";
import type { PermissionRuleScope } from "../types";

export type RuleAction = PermissionRule["action"];

/** Repository config may only tighten, so project scope offers deny and ask. */
export function actionsForScope(scope: PermissionRuleScope): RuleAction[] {
  return scope === "project" ? ["deny", "ask"] : ["deny", "ask", "allow"];
}

export type RuleForm = { action: RuleAction; tool: string; match: string };

export type RuleFormResult = { ok: true; rule: PermissionRule } | { ok: false; error: "tool" | "action" };

export function ruleFromForm(form: RuleForm, scope: PermissionRuleScope): RuleFormResult {
  const tool = form.tool.trim();
  if (tool === "") return { ok: false, error: "tool" };
  if (!actionsForScope(scope).includes(form.action)) return { ok: false, error: "action" };
  const match = form.match.trim();
  return { ok: true, rule: { action: form.action, tool, ...(match !== "" ? { match } : {}) } };
}

export function formFromRule(rule: PermissionRule | undefined, scope: PermissionRuleScope): RuleForm {
  return rule
    ? { action: rule.action, tool: rule.tool, match: rule.match ?? "" }
    : { action: actionsForScope(scope)[0]!, tool: "", match: "" };
}

/** Tools people usually write rules for; any tool name (or "*") is accepted. */
export const COMMON_RULE_TOOLS = [
  "*",
  "run_command",
  "write_file",
  "apply_patch",
  "read_file",
  "web_fetch",
  "web_search",
  "git_commit",
  "task_kill",
] as const;
