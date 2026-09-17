import * as fs from "node:fs";
import * as path from "node:path";
import { PERMISSION_LEVEL, type PermissionRule } from "@seekforge/shared";
import type { ToolContext } from "./index.js";
import type { ClassifiedCall } from "./registry.js";
import { hasShellControlSyntax } from "./run-command.js";
import {
  normalizeWhitespace,
  relativeToAny,
  ruleMatches as matchRule,
  SHELL_COMMAND_TOOLS,
  SHELL_EXECUTING_TOOLS,
  toolPatternMatches,
  workspaceRelative,
  type PathSubjects,
} from "./rule-match.js";
import { physicalToolPath } from "./sandbox.js";

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

/** A refusal reached without asking anyone (see denyBeforePrompt). */
export type PermissionRefusal = Extract<PermissionOutcome, { allowed: false }>;

/**
 * Separates a non-command grant's tool name from its scope. A shell command
 * containing NUL can never be spawned, so no command grant can collide with a
 * tool grant, and the command matcher skips any entry that carries one.
 */
const GRANT_SEPARATOR = "\u0000";

/**
 * The token an allow-for-session confirmation remembers, and that subsequent
 * calls are matched against:
 *
 * - shell tools: the classified command (prefix-matched, like
 *   commandAllowlist);
 * - tools with a path: the tool plus the PHYSICAL directory of that path. One
 *   "don't ask again" on `src/a.ts` covers the other files directly in `src/`
 *   — the same folder the user was looking at — but not `src/sub/`, not the
 *   parent, and not `.github/workflows/`. A bare tool name, which this used to
 *   be, covered every path for the rest of the run. Physical, so a symlink
 *   inside the approved folder cannot carry the grant somewhere else. An exact
 *   file was the other option; it makes the answer useless for the common
 *   "create these three files here" and buys little over the directory, whose
 *   contents the user can see;
 * - anything else: the tool itself.
 *
 * "" means "cannot be granted" (a path that does not resolve).
 */
function sessionToken(toolName: string, cls: ClassifiedCall, ctx: ToolContext): string {
  if (SHELL_COMMAND_TOOLS.has(toolName)) {
    return (cls.command ?? "").trim();
  }
  if (cls.path !== undefined) {
    // An empty path names the workspace itself, whose "directory" is its parent.
    if (cls.path.trim() === "") return "";
    try {
      const physical = physicalToolPath(ctx.workspace, cls.path);
      return `${toolName}${GRANT_SEPARATOR}${path.dirname(physical)}`;
    } catch {
      return "";
    }
  }
  return `${toolName}${GRANT_SEPARATOR}`;
}

/**
 * Whether an allow-for-session answer may cover LATER calls of this kind.
 *
 * L3 `env` may not. "Always confirm" is what the level means (PermissionName in
 * @seekforge/shared, docs/security-model.md §1) and what the env tools promise
 * individually: web_fetch/web_search show the raw URL, browser_navigate the raw
 * URL, a browser interaction the raw selector and page. The session token for
 * all of them is the BARE TOOL NAME — it carries no URL, no origin, no selector
 * — so remembering one answer would auto-approve every later navigation to any
 * host and every later click on any element, in a mode whose whole contract is
 * that these are the calls a human still sees. One keypress must not buy that.
 *
 * A user-written `allow` rule can still cover an env tool, deliberately and
 * with a `match` the user chose (e.g. a docs domain); it is checked before this.
 */
function sessionGrantable(cls: ClassifiedCall): boolean {
  return PERMISSION_LEVEL[cls.permission] < PERMISSION_LEVEL.env;
}

/** True when a prior allow-for-session entry covers this call. */
function sessionAllowed(toolName: string, cls: ClassifiedCall, ctx: ToolContext): boolean {
  if (!sessionGrantable(cls)) return false;
  const list = ctx.policy.sessionAllowlist;
  if (!list || list.length === 0) return false;
  const token = sessionToken(toolName, cls, ctx);
  if (token === "") return false;
  if (SHELL_EXECUTING_TOOLS.has(toolName) && hasShellControlSyntax(token)) return false;
  if (SHELL_COMMAND_TOOLS.has(toolName)) {
    // Prefix-match on a command boundary — exact match or the entry followed by
    // a space. A bare `startsWith` would let `npm run build` auto-approve
    // `npm run build-all` or `npm run build; rm -rf .`, smuggling past the gate.
    return list.some((entry) => !entry.includes(GRANT_SEPARATOR) && (token === entry || token.startsWith(`${entry} `)));
  }
  return list.includes(token);
}

/**
 * The rule an "allow always" answer would write — or undefined when this call
 * must not be granted durably.
 *
 * Three decisions are encoded here, and all three are narrower than what the
 * rule engine would accept, because a rule created by pressing one key
 * deserves less reach than one a person typed into their own config.
 *
 * **Only shell commands.** A command is an identity a person recognizes a year
 * later ("pnpm test"), and `ruleMatches` anchors it on a token boundary. The
 * other things that carry a `command` do not have that property: web_fetch
 * classifies as `GET <url>` and web_search as `SEARCH <query>`, both matched by
 * an unanchored prefix — deliberately, because a hand-written rule for a docs
 * domain is meant to cover its sub-paths. A rule generated from ONE url the
 * model chose is not that: `GET https://host/doc.md` would also match
 * `https://host/doc.md.attacker.example/leak?secret=…`, forever, in every
 * project. Paths are excluded for the neighboring reason — a path is a location
 * whose contents change under a grant that outlives them, and `acceptEdits` is
 * the deliberate way to edit freely.
 *
 * **Never a compound command.** enforcePermission already refuses to let an
 * allow rule match a command containing shell control syntax, so persisting
 * `pnpm test && curl … | sh` would write a rule that can never fire: a grant
 * that reads as broad and behaves as nothing. Refusing to offer it is honest;
 * writing a decorative rule is not.
 *
 * **Never a dangerous call.** Those are refused before any prompt; a durable
 * grant must not be the thing that reopens them.
 */
export function proposeDurableRule(toolName: string, cls: ClassifiedCall): PermissionRule | undefined {
  if (cls.permission === "dangerous") return undefined;
  // Restricted to the tools whose allow rules are matched on a token boundary
  // — the same scoping ruleMatches and sessionAllowed use.
  if (!SHELL_COMMAND_TOOLS.has(toolName)) return undefined;
  if (cls.command === undefined) return undefined;
  const match = normalizeWhitespace(cls.command);
  if (match === "") return undefined;
  if (hasShellControlSyntax(match)) return undefined;
  // A `*` would be read back as a wildcard, granting more than was approved.
  if (match.includes("*")) return undefined;
  return { action: "allow", tool: toolName, match };
}

async function confirmWithUser(
  toolName: string,
  cls: ClassifiedCall,
  ctx: ToolContext,
  // An ask rule demands a person for every matching call, so nothing this
  // answer says may cover the next one.
  askRule = false,
): Promise<PermissionOutcome> {
  const durable = ctx.persistRule && !askRule ? proposeDurableRule(toolName, cls) : undefined;
  const grantable = !askRule && sessionGrantable(cls);
  const answer = await ctx.confirm({
    toolName,
    permission: cls.permission,
    description: cls.description,
    // Raw values, never paraphrased — prompt-injection defense.
    ...(cls.command !== undefined ? { command: cls.command } : {}),
    ...(cls.path !== undefined ? { path: cls.path } : {}),
    ...(cls.preview !== undefined ? { preview: cls.preview } : {}),
    ...(cls.hunks !== undefined ? { hunks: cls.hunks } : {}),
    // The rule the frontend may offer to persist — computed here so what it
    // shows and what gets written are the same object, never a paraphrase.
    ...(durable !== undefined ? { rememberRule: durable } : {}),
    // Same reasoning as rememberRule: the frontend must not offer a grant this
    // layer will refuse to remember.
    ...(grantable ? {} : { sessionGrantable: false }),
  });
  // Normalize the boolean | { allow, remember } | { allow, selectedHunks }
  // contract. A bare boolean is treated exactly as before.
  const allow = typeof answer === "boolean" ? answer : answer.allow;
  const remember = typeof answer !== "boolean" && "remember" in answer ? answer.remember : undefined;
  const feedback = typeof answer !== "boolean" && "feedback" in answer ? answer.feedback : undefined;
  const selectedHunks = typeof answer !== "boolean" && "selectedHunks" in answer ? answer.selectedHunks : undefined;
  if (allow) {
    if (remember === "always" && durable !== undefined) {
      // Persist first, then fall through to the session grant: a rule that
      // failed to write must not leave the run believing it was remembered,
      // and a run that keeps working after a failed write is better than one
      // that dies over a config file. The host reports what it did.
      try {
        await ctx.persistRule?.(durable);
      } catch {
        // Ignored on purpose — the session grant below still applies.
      }
    }
    if ((remember === "session" || remember === "always") && grantable) {
      // Grow the run's in-memory session allowlist in place so the next
      // matching call auto-allows. Mutating the array the caller shares
      // across the session's calls is the whole point of the channel.
      const token = sessionToken(toolName, cls, ctx);
      const list = (ctx.policy.sessionAllowlist ??= []);
      const forged = SHELL_COMMAND_TOOLS.has(toolName) && token.includes(GRANT_SEPARATOR);
      if (token !== "" && !forged && !list.includes(token)) list.push(token);
    }
    return { allowed: true, decision: "user_approved", ...(selectedHunks !== undefined ? { selectedHunks } : {}) };
  }
  const note = typeof feedback === "string" ? feedback.trim().slice(0, MAX_DENIAL_FEEDBACK_CHARS) : "";
  return {
    allowed: false,
    decision: "user_denied",
    errorCode: "denied_by_user",
    errorMessage:
      `User denied ${cls.permission} permission for ${toolName}` + (note !== "" ? `. The user said: ${note}` : ""),
  };
}

/** A refusal note is guidance, not a document; bound what reaches the model. */
const MAX_DENIAL_FEEDBACK_CHARS = 2000;

/**
 * Evaluates rules against one call. The path forms are computed once, and only
 * when a rule actually needs them — resolving a path touches the filesystem.
 */
function ruleMatcher(toolName: string, cls: ClassifiedCall, ctx: ToolContext): (rule: PermissionRule) => boolean {
  let subject: Parameters<typeof matchRule>[1] | undefined;
  const build = (): Parameters<typeof matchRule>[1] => {
    const raw = cls.path ?? "";
    const workspaces = [ctx.workspace];
    let physical: string | undefined;
    try {
      const real = fs.realpathSync(ctx.workspace);
      if (real !== ctx.workspace) workspaces.push(real);
      if (raw.trim() !== "" && cls.command === undefined) {
        physical = workspaceRelative(real, physicalToolPath(ctx.workspace, raw));
      }
    } catch {
      // Unresolvable: the lexical form is all there is, and the tool itself
      // will refuse a path it cannot resolve.
    }
    const paths: PathSubjects = {
      lexical: relativeToAny(raw, workspaces),
      ...(physical !== undefined ? { physical } : {}),
    };
    return {
      toolName,
      ...(cls.command !== undefined ? { command: cls.command } : {}),
      path: paths,
      workspaces,
    };
  };
  return (rule) =>
    toolPatternMatches(rule.tool, toolName) && (rule.match === undefined || matchRule(rule, (subject ??= build())));
}

/**
 * The refusals that need no input from anyone: the run's allow-list, deny
 * rules, ask mode, and the absolute denylist. Returns undefined when the call
 * survives them — which is not yet an approval, only "nothing rejected it out
 * of hand".
 *
 * Split out so the dispatcher can apply it BEFORE a tool's async `prepare`
 * step. Classification used to be pure, which made "no work happens before the
 * permission decision" structural; a tool that does I/O to describe its own
 * change would otherwise do that work even for a call the policy refuses.
 */
export function denyBeforePrompt(
  toolName: string,
  cls: ClassifiedCall,
  ctx: ToolContext,
): PermissionRefusal | undefined {
  if (ctx.policy.allowedTools && !ctx.policy.allowedTools.includes(toolName)) {
    return {
      allowed: false,
      decision: "deny_rule",
      errorCode: "tool_not_allowed",
      errorMessage: `Tool ${toolName} is outside the run's allowedTools list`,
    };
  }

  // Deny rules first: a matching deny blocks at EVERY level (incl. readonly),
  // never prompts, never runs. First matching deny in the array wins.
  const matches = ruleMatcher(toolName, cls, ctx);
  const deny = (ctx.policy.rules ?? []).find((r) => r.action === "deny" && matches(r));
  if (deny) {
    return {
      allowed: false,
      decision: "deny_rule",
      errorCode: "denied_by_rule",
      errorMessage: `Denied by policy rule (tool: ${deny.tool}${deny.match !== undefined ? `, match: ${deny.match}` : ""}): ${cls.description}`,
    };
  }

  // Read-only survives everything below, so nothing further can refuse it.
  if (PERMISSION_LEVEL[cls.permission] === 0) return undefined;

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

  return undefined;
}

export async function enforcePermission(
  toolName: string,
  cls: ClassifiedCall,
  ctx: ToolContext,
): Promise<PermissionOutcome> {
  const refused = denyBeforePrompt(toolName, cls, ctx);
  if (refused) return refused;

  const rules = ctx.policy.rules ?? [];
  const matches = ruleMatcher(toolName, cls, ctx);

  // Ask rules sit between deny and everything that would run the call without
  // a person: they outrank read-only auto-approval, allow rules, the session
  // allowlist and every approval mode. What the user answers is still only
  // this call's answer — see sessionGrantable for what "remember" may cover.
  if (rules.some((r) => r.action === "ask" && matches(r))) {
    return confirmWithUser(toolName, cls, ctx, true);
  }

  if (PERMISSION_LEVEL[cls.permission] === 0) {
    return { allowed: true, decision: "auto_readonly" };
  }

  // Allow rules: a matching allow skips the prompt — including for "env"
  // (that's the point: e.g. allow web_fetch for a specific docs domain).
  const compoundShellCommand =
    SHELL_EXECUTING_TOOLS.has(toolName) && cls.command !== undefined && hasShellControlSyntax(cls.command);
  const allow = compoundShellCommand ? undefined : rules.find((r) => r.action === "allow" && matches(r));
  if (allow) {
    return { allowed: true, decision: "allow_rule" };
  }

  // Allow-for-session: a prior "yes, don't ask again" covers this call. Scanned
  // after deny/dangerous/allow-rules (which stay authoritative) but before any
  // fresh prompt — for write/execute only; see sessionGrantable for why L3 env
  // is confirmed every time whatever the user answered before.
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
