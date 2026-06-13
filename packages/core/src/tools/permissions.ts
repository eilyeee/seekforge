import { PERMISSION_LEVEL, type PermissionRule } from "@seekforge/shared";
import type { ToolContext } from "./index.js";
import type { ClassifiedCall } from "./registry.js";

export type PermissionDecision =
  | "auto_readonly" // L0, always allowed
  | "auto_policy" // L1 with approvalMode "auto"
  | "auto_accept_edits" // L1 write auto-allowed by approvalMode "acceptEdits"
  | "allowlist" // L2 command matched an allowlist
  | "session_allowlist" // matched the run's allow-for-session allowlist
  | "user_approved" // user said yes
  | "user_denied" // user said no
  | "forbidden_ask_mode" // mode "ask" forbids everything above L0
  | "denied_dangerous" // L4 is never run, never prompted
  | "deny_rule" // a policy deny rule matched — never run, never prompted
  | "allow_rule"; // a policy allow rule matched — runs without prompting

export type PermissionOutcome =
  | { allowed: true; decision: PermissionDecision }
  | { allowed: false; decision: PermissionDecision; errorCode: string; errorMessage: string };

/**
 * The token an allow-for-session confirmation remembers, and that subsequent
 * calls are matched against: the classified command for run_command/task_kill
 * (prefix-matched, like commandAllowlist), else the bare tool name.
 */
function sessionToken(toolName: string, cls: ClassifiedCall): string {
  if (toolName === "run_command" || toolName === "task_kill") {
    return (cls.command ?? "").trim();
  }
  return toolName;
}

/** True when a prior allow-for-session entry covers this call. */
function sessionAllowed(toolName: string, cls: ClassifiedCall, ctx: ToolContext): boolean {
  const list = ctx.policy.sessionAllowlist;
  if (!list || list.length === 0) return false;
  const token = sessionToken(toolName, cls);
  if (token === "") return false;
  if (toolName === "run_command" || toolName === "task_kill") {
    return list.some((entry) => token.startsWith(entry));
  }
  return list.includes(token);
}

async function confirmWithUser(
  toolName: string,
  cls: ClassifiedCall,
  ctx: ToolContext,
): Promise<PermissionOutcome> {
  const answer = await ctx.confirm({
    toolName,
    permission: cls.permission,
    description: cls.description,
    // Raw values, never paraphrased — prompt-injection defense.
    ...(cls.command !== undefined ? { command: cls.command } : {}),
    ...(cls.path !== undefined ? { path: cls.path } : {}),
    ...(cls.preview !== undefined ? { preview: cls.preview } : {}),
  });
  // Normalize the boolean | { allow, remember } contract. A bare boolean is
  // treated exactly as before (allow-once / deny, no allowlist growth).
  const allow = typeof answer === "boolean" ? answer : answer.allow;
  const remember = typeof answer === "boolean" ? undefined : answer.remember;
  if (allow) {
    if (remember === "session") {
      // Grow the run's in-memory session allowlist in place so the next
      // matching call auto-allows. Mutating the array the caller shares
      // across the session's calls is the whole point of the channel.
      const token = sessionToken(toolName, cls);
      const list = (ctx.policy.sessionAllowlist ??= []);
      if (token !== "" && !list.includes(token)) list.push(token);
    }
    return { allowed: true, decision: "user_approved" };
  }
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

  // Allow-for-session: a prior "yes, don't ask again" covers this call. Scanned
  // after deny/dangerous/allow-rules (which stay authoritative) but before any
  // fresh prompt, for write/execute/env alike.
  if (sessionAllowed(toolName, cls, ctx)) {
    return { allowed: true, decision: "session_allowlist" };
  }

  switch (cls.permission) {
    case "write":
      // "auto" allows every write; "acceptEdits" auto-allows in-workspace
      // writes too (the "edit freely, ask before running" tier). Other modes
      // (confirm/manual) prompt.
      if (ctx.policy.approvalMode === "auto") {
        return { allowed: true, decision: "auto_policy" };
      }
      if (ctx.policy.approvalMode === "acceptEdits") {
        return { allowed: true, decision: "auto_accept_edits" };
      }
      return confirmWithUser(toolName, cls, ctx);
    case "execute":
      if (cls.allowlisted) {
        return { allowed: true, decision: "allowlist" };
      }
      // acceptEdits deliberately does NOT auto-allow command execution — it
      // still confirms, so the user approves anything that runs.
      return confirmWithUser(toolName, cls, ctx);
    case "env":
      // Env changes always require explicit confirmation, even in "auto"/
      // "acceptEdits".
      return confirmWithUser(toolName, cls, ctx);
    default:
      return confirmWithUser(toolName, cls, ctx);
  }
}
