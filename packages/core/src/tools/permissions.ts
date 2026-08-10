import { normalize, sep } from "node:path";
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

/** A refusal reached without asking anyone (see denyBeforePrompt). */
export type PermissionRefusal = Extract<PermissionOutcome, { allowed: false }>;

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
  if (toolName !== "run_command" && toolName !== "task_kill") return undefined;
  if (cls.command === undefined) return undefined;
  const match = normalizeWhitespace(cls.command);
  if (match === "") return undefined;
  if (hasShellControlSyntax(match)) return undefined;
  return { action: "allow", tool: toolName, match };
}

async function confirmWithUser(toolName: string, cls: ClassifiedCall, ctx: ToolContext): Promise<PermissionOutcome> {
  const durable = ctx.persistRule ? proposeDurableRule(toolName, cls) : undefined;
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
    ...(sessionGrantable(cls) ? {} : { sessionGrantable: false }),
  });
  // Normalize the boolean | { allow, remember } | { allow, selectedHunks }
  // contract. A bare boolean is treated exactly as before.
  const allow = typeof answer === "boolean" ? answer : answer.allow;
  const remember = typeof answer !== "boolean" && "remember" in answer ? answer.remember : undefined;
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
    if ((remember === "session" || remember === "always") && sessionGrantable(cls)) {
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

function normalizeRulePath(value: string): string {
  const trimmed = value.trim();
  return trimmed === "" ? "" : normalize(trimmed);
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
  // Permission rules must see the same lexical identity as the filesystem.
  // Otherwise an allow for `src` also grants `src/../outside.ts`, while a deny
  // for `secrets` misses `src/../secrets/key.txt`.
  const subject = normalizeRulePath(cls.path ?? "");
  const match = normalizeRulePath(rule.match);
  return boundary ? boundaryPrefix(subject, match, ["/", sep]) : subject.startsWith(match);
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
  const deny = (ctx.policy.rules ?? []).find((r) => r.action === "deny" && ruleMatches(r, toolName, cls));
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

  if (PERMISSION_LEVEL[cls.permission] === 0) {
    return { allowed: true, decision: "auto_readonly" };
  }

  const rules = ctx.policy.rules ?? [];

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
