/**
 * Run-scoped subagent definitions passed inline (CLI `--agents '<json>'`), in
 * Claude Code's shape: an object keyed by agent id, each value carrying
 * `description` and `prompt` plus optional fields.
 *
 * Every definition is rendered to canonical AGENT.md and parsed back with the
 * same parser the on-disk loader uses, so an inline agent is validated exactly
 * like `.seekforge/agents/<id>/AGENT.md`. Inline definitions come from the
 * person invoking the command, so they carry user authority (scope "global")
 * and override loaded definitions with the same id for that run only.
 *
 * The AGENT.md parser is lenient where a file on disk should keep loading (an
 * unknown skill id or an unmappable hook is dropped). A value typed on the
 * command line gets no such benefit of the doubt: anything the parser would
 * drop is refused here, so what runs is what the user wrote.
 */
import { parseHookEntry } from "@seekforge/shared";
import type { HookConfig } from "../hooks/index.js";
import { mapAgentToolName, parseAgentHooks, parseEffort, parseIsolation, parsePermissionMode } from "./fields.js";
import { AGENT_ID_RE, type FrontmatterValue } from "./frontmatter.js";
import { renderAgentMarkdown } from "./import.js";
import { MAX_AGENT_DEFINITION_BYTES, parseAgentMarkdown } from "./load.js";
import type { AgentDefinition } from "./types.js";

export const MAX_INLINE_AGENTS = 32;
export const MAX_INLINE_AGENTS_BYTES = MAX_AGENT_DEFINITION_BYTES;

const STRING_FIELDS = [
  "description",
  "prompt",
  "name",
  "model",
  "own",
  "doNotTouch",
  "boundary",
  "permissionMode",
  "isolation",
  "effort",
  "color",
] as const;
const KNOWN_FIELDS = new Set<string>([
  ...STRING_FIELDS,
  "tools",
  "disallowedTools",
  "triggers",
  "mode",
  "maxTurns",
  "skills",
  "mcpServers",
  "hooks",
]);

/** Keys of a SeekForge-shaped agent hook entry. */
const HOOK_ENTRY_KEYS = new Set(["type", "match", "pattern", "command"]);
/** Keys of a Claude Code-shaped entry (`{ matcher, hooks: [...] }`) and of each hook inside it. */
const CLAUDE_HOOK_ENTRY_KEYS = new Set(["matcher", "hooks"]);
const CLAUDE_HOOK_KEYS = new Set(["type", "command"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, field: string, separator: string, where: string): string[] {
  const items = typeof value === "string" ? value.split(separator) : value;
  if (!Array.isArray(items) || !items.every((item) => typeof item === "string")) {
    throw new Error(`${where}: "${field}" must be an array of strings`);
  }
  const trimmed = items.map((item) => item.trim()).filter((item) => item !== "");
  for (const item of trimmed) {
    if (item.includes(separator))
      throw new Error(`${where}: "${field}" entry "${item}" may not contain "${separator}"`);
  }
  return trimmed;
}

function rejectUnknownKeys(value: Record<string, unknown>, known: ReadonlySet<string>, at: string): void {
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(`${at}: unsupported key(s) ${unknown.join(", ")} (supported: ${[...known].join(", ")})`);
  }
}

/** A command hook, checked by the shared hook-entry validator. Agent hooks run commands only. */
function checkCommandHook(hook: Record<string, unknown>, at: string): void {
  const parsed = parseHookEntry(hook);
  if (!parsed.ok) throw new Error(`${at}: ${parsed.error}`);
  if ((parsed.value.type ?? "command") !== "command") throw new Error(`${at}: agent hooks run commands only`);
}

/**
 * `hooks` in either shape parseAgentHooks reads. The stage names and the
 * Claude matcher mapping stay with parseAgentHooks: each entry is run through
 * it alone, and one that comes back empty is refused instead of dropped.
 */
function inlineHooks(value: unknown, where: string): HookConfig | undefined {
  if (!isPlainObject(value)) throw new Error(`${where}: "hooks" must be an object keyed by stage`);
  const expected = new Map<string, number>();
  for (const [stage, entries] of Object.entries(value)) {
    const probe = parseAgentHooks({ [stage]: [{ command: "true" }] });
    const canonical = probe ? Object.keys(probe)[0] : undefined;
    if (canonical === undefined) {
      throw new Error(`${where}: hook stage "${stage}" is not available to an agent (preToolUse, postToolUse, Stop)`);
    }
    if (!Array.isArray(entries)) throw new Error(`${where}: "hooks.${stage}" must be an array`);
    entries.forEach((entry: unknown, index) => {
      const at = `${where}: "hooks.${stage}[${index}]"`;
      if (!isPlainObject(entry)) throw new Error(`${at} must be an object`);
      if (entry["hooks"] !== undefined) {
        rejectUnknownKeys(entry, CLAUDE_HOOK_ENTRY_KEYS, at);
        if (entry["matcher"] !== undefined && typeof entry["matcher"] !== "string") {
          throw new Error(`${at}: "matcher" must be a string`);
        }
        if (!Array.isArray(entry["hooks"])) throw new Error(`${at}: "hooks" must be an array`);
        entry["hooks"].forEach((hook: unknown, inner) => {
          const hookAt = `${at}.hooks[${inner}]`;
          if (!isPlainObject(hook)) throw new Error(`${hookAt} must be an object`);
          rejectUnknownKeys(hook, CLAUDE_HOOK_KEYS, hookAt);
          checkCommandHook(hook, hookAt);
        });
      } else {
        rejectUnknownKeys(entry, HOOK_ENTRY_KEYS, at);
        checkCommandHook(entry, at);
      }
      const produced = parseAgentHooks({ [stage]: [entry as unknown as FrontmatterValue] })?.[
        canonical as keyof HookConfig
      ];
      if (!produced || produced.length === 0) {
        throw new Error(
          `${at} is not a usable agent hook (a command of at most 4096 characters; a Claude Code "matcher" ` +
            'must name tools, like "Bash" or "Edit|Write")',
        );
      }
      expected.set(canonical, (expected.get(canonical) ?? 0) + produced.length);
    });
  }
  const hooks = parseAgentHooks(value as unknown as FrontmatterValue);
  for (const [stage, count] of expected) {
    const kept = hooks?.[stage as keyof HookConfig]?.length ?? 0;
    if (kept < count) throw new Error(`${where}: too many "${stage}" hooks (at most ${kept} per stage)`);
  }
  return hooks;
}

/**
 * Parses the raw `--agents` value. Throws an Error naming the agent and field
 * on any problem; unknown fields are rejected rather than ignored, because a
 * silently dropped field could leave an agent with more reach than its author
 * wrote.
 */
export function parseInlineAgentDefinitions(raw: string): AgentDefinition[] {
  if (Buffer.byteLength(raw, "utf8") > MAX_INLINE_AGENTS_BYTES) {
    throw new Error(`--agents JSON exceeds ${MAX_INLINE_AGENTS_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`--agents is not valid JSON (${error instanceof Error ? error.message : "parse error"})`);
  }
  if (!isPlainObject(parsed)) throw new Error("--agents must be a JSON object keyed by agent id");
  const entries = Object.entries(parsed);
  if (entries.length === 0) throw new Error("--agents defines no agents");
  if (entries.length > MAX_INLINE_AGENTS) throw new Error(`--agents defines more than ${MAX_INLINE_AGENTS} agents`);

  return entries.map(([id, value]) => {
    const where = `--agents "${id}"`;
    if (!AGENT_ID_RE.test(id)) {
      throw new Error(`${where}: agent ids must be kebab-case (lowercase letters, digits, "-")`);
    }
    if (!isPlainObject(value)) throw new Error(`${where}: the definition must be an object`);
    const unknown = Object.keys(value).filter((key) => !KNOWN_FIELDS.has(key));
    if (unknown.length > 0) {
      throw new Error(
        `${where}: unsupported field(s) ${unknown.join(", ")} (supported: ${[...KNOWN_FIELDS].sort().join(", ")})`,
      );
    }
    const text: Partial<Record<(typeof STRING_FIELDS)[number], string>> = {};
    for (const field of STRING_FIELDS) {
      const fieldValue = value[field];
      if (fieldValue === undefined) continue;
      if (typeof fieldValue !== "string") throw new Error(`${where}: "${field}" must be a string`);
      text[field] = fieldValue;
    }
    const description = text.description?.replace(/\s+/g, " ").trim() ?? "";
    if (description === "") throw new Error(`${where}: "description" is required`);
    const prompt = text.prompt?.trim() ?? "";
    if (prompt === "") throw new Error(`${where}: "prompt" is required`);

    let mode: "ask" | "edit" = "edit";
    if (value.mode !== undefined) {
      if (value.mode !== "ask" && value.mode !== "edit") throw new Error(`${where}: "mode" must be "ask" or "edit"`);
      mode = value.mode;
    }
    let maxTurns: number | undefined;
    if (value.maxTurns !== undefined) {
      if (typeof value.maxTurns !== "number" || !Number.isSafeInteger(value.maxTurns) || value.maxTurns < 1) {
        throw new Error(`${where}: "maxTurns" must be a positive integer`);
      }
      maxTurns = value.maxTurns;
    }
    const oneLine = (field: string | undefined): string | undefined => field?.replace(/\s+/g, " ").trim() || undefined;
    // "inherit" is Claude Code's spelling of "use the session's model".
    const model = oneLine(text.model);

    // Claude Code tool names (`Read`, `Bash`) mean SeekForge's; a name with no
    // equivalent stays as written and simply matches no tool.
    const tools =
      value.tools === undefined
        ? undefined
        : [
            ...new Set(
              stringList(value.tools, "tools", ",", where).flatMap((name) => mapAgentToolName(name) ?? [name]),
            ),
          ];
    // A deny list entry the parser cannot map would be dropped, leaving the
    // tool usable: refuse it instead.
    const disallowedTools =
      value.disallowedTools === undefined
        ? undefined
        : stringList(value.disallowedTools, "disallowedTools", ",", where);
    const unknownDenied = (disallowedTools ?? []).filter((name) => mapAgentToolName(name) === undefined);
    if (unknownDenied.length > 0) {
      throw new Error(`${where}: "disallowedTools" names no known tool: ${unknownDenied.join(", ")}`);
    }
    const fieldError = (error: unknown): Error =>
      new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    let permissionMode: AgentDefinition["permissionMode"];
    let isolation: AgentDefinition["isolation"];
    try {
      permissionMode = parsePermissionMode(text.permissionMode);
      isolation = parseIsolation(text.isolation);
    } catch (error) {
      throw fieldError(error);
    }
    const effort = text.effort === undefined ? undefined : parseEffort(text.effort);
    if (text.effort !== undefined && effort === undefined) {
      throw new Error(`${where}: "effort" must be low, medium, high or max`);
    }
    const skills =
      value.skills === undefined ? undefined : [...new Set(stringList(value.skills, "skills", ",", where))];
    const mcpServers =
      value.mcpServers === undefined ? undefined : [...new Set(stringList(value.mcpServers, "mcpServers", ",", where))];
    const hooks = value.hooks === undefined ? undefined : inlineHooks(value.hooks, where);

    // The on-disk parser is the validator of record: render, then parse back.
    const markdown = renderAgentMarkdown({
      id,
      name: oneLine(text.name) ?? id,
      description,
      triggers: value.triggers === undefined ? [] : stringList(value.triggers, "triggers", "|", where),
      ...(tools !== undefined ? { tools } : {}),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
      mode,
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(isolation !== undefined ? { isolation } : {}),
      ...(skills !== undefined ? { skills } : {}),
      ...(effort !== undefined ? { effort } : {}),
      // Cosmetic: a color the frontends cannot render is dropped by the parser.
      ...(text.color !== undefined ? { color: text.color } : {}),
      ...(mcpServers !== undefined ? { mcpServers } : {}),
      ...(hooks !== undefined ? { hooks } : {}),
      own: oneLine(text.own),
      doNotTouch: oneLine(text.doNotTouch),
      boundary: oneLine(text.boundary),
      maxTurns,
      model: model === "inherit" ? undefined : model,
      body: prompt,
    });
    let def: AgentDefinition;
    try {
      def = parseAgentMarkdown("global", id, markdown);
    } catch (error) {
      throw fieldError(error);
    }
    const dropped = (field: string, given: string[] | undefined, kept: string[] | undefined): void => {
      const missing = (given ?? []).filter((item) => !(kept ?? []).includes(item));
      if (missing.length > 0)
        throw new Error(`${where}: "${field}" has invalid entries (or more than 32): ${missing.join(", ")}`);
    };
    dropped("skills", skills, def.skills);
    dropped("mcpServers", mcpServers, def.mcpServers);
    return def;
  });
}

/** `defs` with each inline definition replacing the loaded one of the same id. */
export function withInlineAgents(defs: AgentDefinition[], inline: AgentDefinition[]): AgentDefinition[] {
  const byId = new Map(defs.map((def) => [def.id, def]));
  for (const def of inline) byId.set(def.id, def);
  return [...byId.values()];
}
