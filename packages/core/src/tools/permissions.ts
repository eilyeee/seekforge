import { sep } from "node:path";
import { PERMISSION_LEVEL, type PermissionRule } from "@seekforge/shared";
import type { ToolContext } from "./index.js";
import type { ClassifiedCall } from "./registry.js";
import { hasShellControlSyntax } from "./run-command.js";

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
  | { allowed: true; decision: PermissionDecision; selectedHunks?: number[] }
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
  if (toolName === "run_command" && hasShellControlSyntax(token)) return false;
  if (toolName === "run_command" || toolName === "task_kill") {
    // Prefix-match on a command boundary — exact match or the entry followed by
    // a space. A bare `startsWith` would let `npm run build` auto-approve
    // `npm run build-all` or `npm run build; rm -rf .`, smuggling past the gate.
    return list.some((entry) => token === entry || token.startsWith(`${entry} `));
  }
  return list.includes(token);
}

async function confirmWithUser(toolName: string, cls: ClassifiedCall, ctx: ToolContext): Promise<PermissionOutcome> {
  const answer = await ctx.confirm({
    toolName,
    permission: cls.permission,
    description: cls.description,
    // Raw values, never paraphrased — prompt-injection defense.
    ...(cls.command !== undefined ? { command: cls.command } : {}),
    ...(cls.path !== undefined ? { path: cls.path } : {}),
    ...(cls.preview !== undefined ? { preview: cls.preview } : {}),
    ...(cls.hunks !== undefined ? { hunks: cls.hunks } : {}),
  });
  // Normalize the boolean | { allow, remember } | { allow, selectedHunks }
  // contract. A bare boolean is treated exactly as before.
  const allow = typeof answer === "boolean" ? answer : answer.allow;
  const remember = typeof answer !== "boolean" && "remember" in answer ? answer.remember : undefined;
  const selectedHunks = typeof answer !== "boolean" && "selectedHunks" in answer ? answer.selectedHunks : undefined;
  if (allow) {
    if (remember === "session") {
      // Grow the run's in-memory session allowlist in place so the next
      // matching call auto-allows. Mutating the array the caller shares
      // across the session's calls is the whole point of the channel.
      const token = sessionToken(toolName, cls);
      const list = (ctx.policy.sessionAllowlist ??= []);
      if (token !== "" && !list.includes(token)) list.push(token);
    }
    return { allowed: true, decision: "user_approved", ...(selectedHunks !== undefined ? { selectedHunks } : {}) };
  }
  return {
    allowed: false,
    decision: "user_denied",
    errorCode: "denied_by_user",
    errorMessage: `User denied ${cls.permission} permission for ${toolName}`,
  };
}

/** Collapse runs of whitespace so a rule can't be evaded with extra spaces. */
function normalizeWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/**
 * Rule matching: tool must be "*" or the exact tool name; `match` is a
 * prefix test against the classified command (run_command/task_kill) or path
 * (fs tools). No `match` field = matches any call of that tool. Commands are
 * whitespace-normalized on both sides so a deny rule like "rm -rf" isn't
 * bypassed by inserting extra spaces ("rm  -rf") — the classifier normalizes
 * the same way before it runs, so the raw command must not slip past here.
 */
/**
 * Prefix match that only counts on a separator boundary: the rule must either
 * already end at a separator (e.g. `docs/`, `GET https://host/`) or the subject
 * must have a separator immediately after the matched prefix. This preserves
 * documented prefix rules while stopping `npm run build` from auto-approving
 * `npm run build-all`, or `src/foo` from granting `src/foobar.ts`.
 */
function boundaryPrefix(subject: string, match: string, seps: readonly string[]): boolean {
  if (subject === match) return true;
  if (match.length === 0) return true;
  if (!subject.startsWith(match)) return false;
  if (seps.includes(match[match.length - 1]!)) return true;
  return seps.includes(subject[match.length] ?? "");
}

function ruleMatches(rule: PermissionRule, toolName: string, cls: ClassifiedCall): boolean {
  if (rule.tool !== "*" && rule.tool !== toolName) return false;
  if (rule.match === undefined) return true;
  // Allow rules require a boundary so a prefix can't smuggle a sibling command/
  // path past the gate. Deny rules keep the broad prefix test — over-matching a
  // deny fails closed.
  const boundary = rule.action === "allow";
  if (cls.command !== undefined) {
    const subject = normalizeWhitespace(cls.command);
    const match = normalizeWhitespace(rule.match);
    // The command-token boundary applies only to shell tools (run_command/
    // task_kill), matching sessionAllowed's scoping. Other command-bearing tools
    // (web_fetch/web_search) match a URL prefix, where sub-path matching is the
    // documented, intended behavior.
    const shellTool = toolName === "run_command" || toolName === "task_kill";
    return boundary && shellTool ? boundaryPrefix(subject, match, [" "]) : subject.startsWith(match);
  }
  const subject = (cls.path ?? "").trim();
  const match = rule.match.trim();
  return boundary ? boundaryPrefix(subject, match, ["/", sep]) : subject.startsWith(match);
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
  const compoundRunCommand =
    toolName === "run_command" && cls.command !== undefined && hasShellControlSyntax(cls.command);
  const allow = compoundRunCommand
    ? undefined
    : rules.find((r) => r.action === "allow" && ruleMatches(r, toolName, cls));
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
      // "auto" is the full-bypass tier (CLI -y / --permission-mode
      // bypassPermissions, desktop "auto"): it runs every tool without
      // prompting, including command execution. This matches the documented
      // contract ("auto-approve write/execute") and lets headless `-p -y` runs
      // actually run commands instead of auto-denying them.
      if (ctx.policy.approvalMode === "auto") {
        return { allowed: true, decision: "auto_policy" };
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
