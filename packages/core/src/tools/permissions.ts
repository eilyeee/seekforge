import { PERMISSION_LEVEL, type PermissionRule } from "@seekforge/shared";
import type { ToolContext } from "./index.js";
import type { ClassifiedCall } from "./registry.js";

export type PermissionDecision =
  | "auto_readonly" // L0, always allowed
  | "auto_policy" // L1 with approvalMode "auto"
  | "allowlist" // L2 command matched an allowlist
  | "user_approved" // user said yes
  | "user_denied" // user said no
  | "forbidden_ask_mode" // mode "ask" forbids everything above L0
  | "denied_dangerous" // L4 is never run, never prompted
  | "deny_rule" // a policy deny rule matched — never run, never prompted
  | "allow_rule"; // a policy allow rule matched — runs without prompting

export type PermissionOutcome =
  | { allowed: true; decision: PermissionDecision }
  | { allowed: false; decision: PermissionDecision; errorCode: string; errorMessage: string };

async function confirmWithUser(
  toolName: string,
  cls: ClassifiedCall,
  ctx: ToolContext,
): Promise<PermissionOutcome> {
  const approved = await ctx.confirm({
    toolName,
    permission: cls.permission,
    description: cls.description,
    // Raw values, never paraphrased — prompt-injection defense.
    ...(cls.command !== undefined ? { command: cls.command } : {}),
    ...(cls.path !== undefined ? { path: cls.path } : {}),
    ...(cls.preview !== undefined ? { preview: cls.preview } : {}),
  });
  if (approved) return { allowed: true, decision: "user_approved" };
  return {
    allowed: false,
    decision: "user_denied",
    errorCode: "denied_by_user",
    errorMessage: `User denied ${cls.permission} permission for ${toolName}`,
  };
}

/**
 * Rule matching: tool must be "*" or the exact tool name; `match` is a
 * prefix test against the classified raw command (run_command/task_kill)
 * or path (fs tools). No `match` field = matches any call of that tool.
 */
function ruleMatches(rule: PermissionRule, toolName: string, cls: ClassifiedCall): boolean {
  if (rule.tool !== "*" && rule.tool !== toolName) return false;
  if (rule.match === undefined) return true;
  const subject = (cls.command ?? cls.path ?? "").trim();
  return subject.startsWith(rule.match.trim());
}

export async function enforcePermission(
  toolName: string,
  cls: ClassifiedCall,
  ctx: ToolContext,
): Promise<PermissionOutcome> {
  const rules = ctx.policy.rules ?? [];

  // Deny rules first: a matching deny blocks at EVERY level (incl. readonly),
  // never prompts, never runs. First matching deny in the array wins.
  const deny = rules.find((r) => r.action === "deny" && ruleMatches(r, toolName, cls));
  if (deny) {
    return {
      allowed: false,
      decision: "deny_rule",
      errorCode: "denied_by_rule",
      errorMessage: `Denied by policy rule (tool: ${deny.tool}${deny.match !== undefined ? `, match: ${deny.match}` : ""}): ${cls.description}`,
    };
  }

  if (PERMISSION_LEVEL[cls.permission] === 0) {
    return { allowed: true, decision: "auto_readonly" };
  }

  if (ctx.policy.mode === "ask") {
    return {
      allowed: false,
      decision: "forbidden_ask_mode",
      errorCode: "forbidden_in_ask_mode",
      errorMessage: `Tool ${toolName} requires ${cls.permission} permission, forbidden in ask mode`,
    };
  }

  // The denylist stays absolute: an allow rule never rescues a dangerous call.
  if (cls.permission === "dangerous") {
    return {
      allowed: false,
      decision: "denied_dangerous",
      errorCode: "denied_dangerous",
      errorMessage: `Denied: ${cls.description}`,
    };
  }

  // Allow rules: a matching allow skips the prompt — including for "env"
  // (that's the point: e.g. allow web_fetch for a specific docs domain).
  const allow = rules.find((r) => r.action === "allow" && ruleMatches(r, toolName, cls));
  if (allow) {
    return { allowed: true, decision: "allow_rule" };
  }

  switch (cls.permission) {
    case "write":
      if (ctx.policy.approvalMode === "auto") {
        return { allowed: true, decision: "auto_policy" };
      }
      return confirmWithUser(toolName, cls, ctx);
    case "execute":
      if (cls.allowlisted) {
        return { allowed: true, decision: "allowlist" };
      }
      return confirmWithUser(toolName, cls, ctx);
    case "env":
      // Env changes always require explicit confirmation, even in "auto".
      return confirmWithUser(toolName, cls, ctx);
    default:
      return confirmWithUser(toolName, cls, ctx);
  }
}
