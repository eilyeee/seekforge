import type { PermissionRule, ToolResult } from "@seekforge/shared";
import type { AgentDefinition } from "../subagents/types.js";
import { translateToolRules } from "./tool-rules.js";
import type { Skill } from "./types.js";

/**
 * Model-driven skill invocation: argument substitution, the per-run session
 * that remembers what was loaded, and what an active skill does to the run's
 * permissions.
 *
 * Trust follows scope. A skill the user put in their own layer (or approved by
 * enabling its plugin, or that ships with SeekForge) may pre-approve tools with
 * `allowed-tools`, exactly as its author wrote. A project skill is repository
 * content: it may restrict with `disallowed-tools` but its `allowed-tools` is
 * ignored — otherwise cloning a repository would be enough to pre-approve
 * commands in it.
 */

/** The builtin tool the model loads a skill with. */
export const INVOKE_SKILL_TOOL = "invoke_skill";

/** Whether a skill's `allowed-tools` may pre-approve anything. */
export function skillMayPreApprove(skill: Pick<Skill, "scope">): boolean {
  return skill.scope === "builtin" || skill.scope === "global";
}

/** Shell-like split: whitespace separates, single/double quotes group. */
export function splitSkillArguments(args: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  for (const ch of args) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) out.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) out.push(current);
  return out;
}

export type SkillExpansionContext = {
  workspace: string;
  sessionId?: string;
};

const PLACEHOLDER_RE = /\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS(?![A-Za-z0-9_])|\$(\d+)|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const SHELL_INJECTION_RE = /!`[^`]+`/;

/**
 * Claude Code's substitutions, in one pass so a substituted value is never
 * expanded again: `$ARGUMENTS` (the whole string), `$ARGUMENTS[N]` and `$N`
 * (0-based tokens), `$name` for each entry of `arguments`. A placeholder with
 * no value stays literal. A body with no placeholder at all gets the arguments
 * appended, so they are never silently dropped. `${CLAUDE_SKILL_DIR}`,
 * `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PROJECT_DIR}` and `${CLAUDE_SESSION_ID}`
 * resolve to this run's values.
 *
 * `!`command`` blocks are left as text: the model triggers this, and a
 * model-triggered expansion must never run a shell.
 */
export function expandSkillBody(
  skill: Pick<Skill, "content" | "argumentNames" | "dir" | "source">,
  args: string,
  context: SkillExpansionContext,
): { text: string; unexpandedShell: boolean } {
  const tokens = splitSkillArguments(args);
  const names = skill.argumentNames ?? [];
  let placeholders = 0;
  const variables: Record<string, string | undefined> = {
    CLAUDE_SKILL_DIR: skill.dir,
    CLAUDE_PLUGIN_ROOT: skill.source?.pluginRoot,
    CLAUDE_PROJECT_DIR: context.workspace,
    CLAUDE_SESSION_ID: context.sessionId,
  };
  const withVariables = skill.content.replace(/\$\{(CLAUDE_[A-Z_]+)\}/g, (whole, name: string) => {
    const value = variables[name];
    return value === undefined ? whole : value;
  });
  let text = withVariables.replace(
    PLACEHOLDER_RE,
    (whole, indexed: string | undefined, positional: string | undefined, named: string | undefined) => {
      if (indexed !== undefined) {
        placeholders++;
        return tokens[Number(indexed)] ?? whole;
      }
      if (positional !== undefined) {
        // A bare `$5` is as likely to be a price as a placeholder, so it only
        // counts as one when there is a value to put there.
        const value = tokens[Number(positional)];
        if (value === undefined) return whole;
        placeholders++;
        return value;
      }
      if (named === undefined) {
        placeholders++;
        return args;
      }
      const index = names.indexOf(named);
      if (index === -1) return whole;
      placeholders++;
      return tokens[index] ?? whole;
    },
  );
  if (placeholders === 0 && args.trim() !== "") text = `${text.trimEnd()}\n\nARGUMENTS: ${args}`;
  return { text, unexpandedShell: SHELL_INJECTION_RE.test(text) };
}

/** A forked skill run, as the host dispatches it. */
export type SkillForkRequest = {
  skill: Skill;
  definition: AgentDefinition;
  task: string;
  /**
   * The forked skill's own rules. The host appends them to the parent run's
   * current rules, which already include every inline skill activated so far.
   */
  permissionRules: PermissionRule[];
};

export type SkillSessionHost = {
  /** The skills this run may invoke (the run's snapshot); a function is read lazily, once. */
  skills: readonly Skill[] | (() => readonly Skill[]);
  /** Ids the lexical selection already put into the prompt as excerpts. */
  preloaded?: Iterable<string>;
  /** The run's own policy object; inline activation appends rules to it. */
  policy: { rules?: PermissionRule[] };
  workspace: string;
  /** The parent run's mode; an ad-hoc fork runs in it. */
  mode: "ask" | "edit";
  /** Subagents a skill's `agent` may name. */
  agents?: readonly AgentDefinition[];
  /** Runs a forked skill. Absent when the host cannot dispatch subagents. */
  fork?: (request: SkillForkRequest) => Promise<ToolResult>;
  /** Whether the host can switch the model for the rest of the run. */
  canSwitchModel?: boolean;
};

export type SkillActivation = {
  /** True when the same skill with the same arguments was already loaded. */
  alreadyLoaded: boolean;
  /** Rules this activation added (inline) or hands to the fork. */
  rules: PermissionRule[];
  notes: string[];
};

export type SkillSession = {
  readonly skills: readonly Skill[];
  readonly preloaded: ReadonlySet<string>;
  readonly workspace: string;
  readonly mode: "ask" | "edit";
  readonly agents: readonly AgentDefinition[];
  readonly fork?: (request: SkillForkRequest) => Promise<ToolResult>;
  /** Rules added by skills activated inline so far this run. */
  activeRules(): PermissionRule[];
  /**
   * Record an invocation and compute its rules. Inline activations apply the
   * rules to the run's policy; forked ones only return them.
   */
  activate(skill: Skill, args: string, options: { inline: boolean; reload?: boolean }): SkillActivation;
  /** The model a skill asked for since the last call, if the host can switch. */
  takeModelRequest(): string | undefined;
};

export function createSkillSession(host: SkillSessionHost): SkillSession {
  const loaded = new Set<string>();
  const applied: PermissionRule[] = [];
  let pendingModel: string | undefined;
  let skills: readonly Skill[] | undefined = typeof host.skills === "function" ? undefined : host.skills;
  return {
    get skills() {
      if (skills === undefined) skills = (host.skills as () => readonly Skill[])();
      return skills;
    },
    preloaded: new Set(host.preloaded ?? []),
    workspace: host.workspace,
    mode: host.mode,
    agents: host.agents ?? [],
    ...(host.fork ? { fork: host.fork } : {}),
    activeRules: () => [...applied],
    activate(skill, args, options) {
      const key = `${skill.id}\0${args.trim()}`;
      const notes: string[] = [];
      if (loaded.has(key) && options.inline && options.reload !== true) {
        return { alreadyLoaded: true, rules: [], notes };
      }
      loaded.add(key);
      const denied = translateToolRules(skill.disallowedTools ?? [], "deny", host.workspace);
      notes.push(...denied.notes);
      const rules = [...denied.rules];
      if (skill.allowedTools && skill.allowedTools.length > 0) {
        if (skillMayPreApprove(skill)) {
          const allowed = translateToolRules(skill.allowedTools, "allow");
          notes.push(...allowed.notes);
          rules.push(...allowed.rules);
        } else {
          notes.push("allowed-tools was not applied: a project skill may restrict tools but never pre-approve them");
        }
      }
      if (skill.model !== undefined) {
        if (!options.inline) {
          // The fork's definition carries the model.
        } else if (host.canSwitchModel) {
          pendingModel = skill.model;
          notes.push(`the rest of this run uses model ${skill.model}`);
        } else {
          notes.push(`model ${skill.model} was not applied: this host cannot switch models mid-run`);
        }
      }
      if (skill.effort !== undefined) {
        notes.push(`effort ${skill.effort} was not applied: this host cannot change reasoning effort mid-run`);
      }
      if (options.inline && rules.length > 0) {
        const fresh = rules.filter(
          (rule) =>
            !applied.some(
              (existing) =>
                existing.action === rule.action && existing.tool === rule.tool && existing.match === rule.match,
            ),
        );
        applied.push(...fresh);
        // Reassign rather than push: the configured array may be shared with
        // other runs, while this policy object belongs to this run alone.
        host.policy.rules = [...(host.policy.rules ?? []), ...fresh];
      }
      return { alreadyLoaded: false, rules, notes };
    },
    takeModelRequest() {
      const model = pendingModel;
      pendingModel = undefined;
      return model;
    },
  };
}

/** Claude Code's built-in agent types, as SeekForge's closest builtins. */
const CLAUDE_AGENT_ALIASES: Readonly<Record<string, string>> = {
  explore: "explorer",
  plan: "planner",
};

/**
 * The agent a forked skill runs as. A named agent is copied under a
 * skill-specific id so a later `agent_send` cannot resume it without the
 * skill's rules; no agent (or Claude Code's `general-purpose`) means an
 * ad-hoc agent in the parent's mode.
 */
export function skillForkDefinition(
  skill: Skill,
  session: Pick<SkillSession, "agents" | "mode">,
): { definition?: AgentDefinition; error?: string } {
  const requested = skill.agent;
  const id = `skill:${skill.id}`;
  if (requested !== undefined && requested !== "general-purpose") {
    const wanted = CLAUDE_AGENT_ALIASES[requested.toLowerCase()] ?? requested;
    const base = session.agents.find((agent) => agent.id === wanted);
    if (!base) return { error: `skill ${skill.id} asks for agent "${requested}", which is not available` };
    return {
      definition: {
        ...base,
        id,
        name: `${base.name} (skill ${skill.id})`,
        ...(skill.model !== undefined ? { model: skill.model } : {}),
      },
    };
  }
  return {
    definition: {
      id,
      name: `Skill ${skill.name}`,
      description: skill.description,
      triggers: [],
      mode: session.mode,
      scope: skill.scope === "project" ? "project" : skill.scope === "builtin" ? "builtin" : "global",
      ...(skill.model !== undefined ? { model: skill.model } : {}),
    },
  };
}

/** The permission a forked invocation needs: an edit-mode fork may change the workspace. */
export function skillForkMode(skill: Skill, session: Pick<SkillSession, "agents" | "mode">): "ask" | "edit" {
  return skillForkDefinition(skill, session).definition?.mode ?? "edit";
}
