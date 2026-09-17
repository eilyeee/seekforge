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
 */
import { AGENT_ID_RE } from "./frontmatter.js";
import { renderAgentMarkdown } from "./import.js";
import { MAX_AGENT_DEFINITION_BYTES, parseAgentMarkdown } from "./load.js";
import type { AgentDefinition } from "./types.js";

export const MAX_INLINE_AGENTS = 32;
export const MAX_INLINE_AGENTS_BYTES = MAX_AGENT_DEFINITION_BYTES;

/** Cosmetic Claude Code fields with no meaning here; accepted and ignored. */
const IGNORED_FIELDS = new Set(["color"]);
const STRING_FIELDS = ["description", "prompt", "name", "model", "own", "doNotTouch", "boundary"] as const;
const KNOWN_FIELDS = new Set<string>([...STRING_FIELDS, "tools", "triggers", "mode", "maxTurns"]);

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

/**
 * Parses the raw `--agents` value. Throws an Error naming the agent and field
 * on any problem; unknown fields are rejected rather than ignored, because a
 * silently dropped `disallowedTools` or `permissionMode` would leave an agent
 * with more reach than its author wrote.
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
    const unknown = Object.keys(value).filter((key) => !KNOWN_FIELDS.has(key) && !IGNORED_FIELDS.has(key));
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

    // The on-disk parser is the validator of record: render, then parse back.
    const markdown = renderAgentMarkdown({
      id,
      name: oneLine(text.name) ?? id,
      description,
      triggers: value.triggers === undefined ? [] : stringList(value.triggers, "triggers", "|", where),
      ...(value.tools !== undefined ? { tools: stringList(value.tools, "tools", ",", where) } : {}),
      mode,
      own: oneLine(text.own),
      doNotTouch: oneLine(text.doNotTouch),
      boundary: oneLine(text.boundary),
      maxTurns,
      model: model === "inherit" ? undefined : model,
      body: prompt,
    });
    try {
      return parseAgentMarkdown("global", id, markdown);
    } catch (error) {
      throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/** `defs` with each inline definition replacing the loaded one of the same id. */
export function withInlineAgents(defs: AgentDefinition[], inline: AgentDefinition[]): AgentDefinition[] {
  const byId = new Map(defs.map((def) => [def.id, def]));
  for (const def of inline) byId.set(def.id, def);
  return [...byId.values()];
}
