/**
 * Create/edit subagent definitions (`.seekforge/agents/<id>/AGENT.md` in the
 * workspace, or under the SeekForge home) for the Desktop agent editor.
 *
 * Core owns what a definition MEANS: the rendered file is validated with
 * `parseAgentMarkdown` before it is written and must load through
 * `loadAgentDefinitionsFromDirs` afterwards. This module only owns the editor's
 * round trip: the form edits six frontmatter keys, and every other entry —
 * keys another build added, YAML lists, comments — is kept byte-for-byte in its
 * original position unless the user edits or removes it.
 */

import { join } from "node:path";
import {
  agentDefinitionRelPath,
  loadAgentDefinitionsFromDirs,
  MAX_AGENT_DEFINITION_BYTES,
  MAX_AGENT_ID_CHARS,
  parseAgentMarkdown,
  seekforgeHome,
  type AgentDefinition,
} from "@seekforge/core";
import { ConfigValueError, readProjectFile, removeProjectFile, writeProjectFileAtomic } from "./config.js";

export type AgentDefinitionScope = "project" | "global";

/** The frontmatter keys the form owns; everything else is an `extra` entry. */
const FORM_KEYS = ["name", "description", "tools", "mode", "model", "max-turns"] as const;
const FORM_KEY_SET: ReadonlySet<string> = new Set(FORM_KEYS);

/**
 * Core's agent id character rule (frontmatter.ts AGENT_ID_RE, which core does
 * not export); the length cap is core's own constant. The id is a path segment
 * here, so it can never hold a separator or dot. The post-write load check is
 * what proves core accepts it.
 */
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const FRONTMATTER_KEY_RE = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_.:*-]{1,128}$/;
/** Core skips larger definitions; refusing them here keeps a save from vanishing. */
const MAX_AGENT_MARKDOWN_BYTES = MAX_AGENT_DEFINITION_BYTES;
const MAX_EXTRA_VALUE_CHARS = 16_000;

export type AgentExtraField = { key: string; value: string };

/** What the editor reads and writes. `tools: null` = every tool. */
export type AgentDefinitionDraft = {
  name: string;
  description: string;
  tools: string[] | null;
  mode: "ask" | "edit";
  model: string;
  maxTurns: number | null;
  body: string;
  extra: AgentExtraField[];
};

export type AgentDefinitionSource = AgentDefinitionDraft & { id: string; scope: AgentDefinitionScope; path: string };

export class AgentDefinitionError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: "bad_request" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

type FrontmatterEntry = { key: string; lines: string[] };
type SplitMarkdown = { preamble: string[]; entries: FrontmatterEntry[]; body: string };

export function assertAgentId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.length > MAX_AGENT_ID_CHARS || !AGENT_ID_RE.test(id)) {
    throw new AgentDefinitionError(
      400,
      "bad_request",
      `id must be lowercase letters, digits and dashes (max ${MAX_AGENT_ID_CHARS})`,
    );
  }
}

function agentsRootOf(scope: AgentDefinitionScope, workspace: string): string {
  return scope === "project" ? workspace : seekforgeHome();
}

function relPath(id: string): string {
  return agentDefinitionRelPath(id);
}

/** Same frontmatter framing core's parser accepts. */
function splitMarkdown(markdown: string): SplitMarkdown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown);
  if (!match) throw new AgentDefinitionError(400, "bad_request", "definition has no YAML frontmatter");
  const preamble: string[] = [];
  const entries: FrontmatterEntry[] = [];
  for (const line of (match[1] as string).split(/\r?\n/)) {
    const kv = FRONTMATTER_KEY_RE.exec(line);
    if (kv) entries.push({ key: kv[1] as string, lines: [line] });
    else if (entries.length > 0) entries[entries.length - 1]!.lines.push(line);
    else preamble.push(line);
  }
  return { preamble, entries, body: (match[2] as string).trim() };
}

/** The raw YAML value text of an entry: the inline part plus its continuation lines. */
function entryValueText(entry: FrontmatterEntry): string {
  const inline = entry.lines[0]!.slice(entry.key.length + 1);
  return [inline.startsWith(" ") ? inline.slice(1) : inline, ...entry.lines.slice(1)].join("\n");
}

function renderExtra(field: AgentExtraField): string[] {
  const [first = "", ...rest] = field.value.split("\n");
  return [first === "" ? `${field.key}:` : `${field.key}: ${first}`, ...rest];
}

function renderFormKey(key: (typeof FORM_KEYS)[number], draft: AgentDefinitionDraft): string[] {
  switch (key) {
    case "name":
      return draft.name === "" ? [] : [`name: ${JSON.stringify(draft.name)}`];
    case "description":
      return draft.description === "" ? [] : [`description: ${JSON.stringify(draft.description)}`];
    case "tools":
      return draft.tools === null ? [] : [`tools: ${JSON.stringify(draft.tools.join(", "))}`];
    case "mode":
      return [`mode: ${JSON.stringify(draft.mode)}`];
    case "model":
      return draft.model === "" ? [] : [`model: ${JSON.stringify(draft.model)}`];
    case "max-turns":
      return draft.maxTurns === null ? [] : [`max-turns: ${draft.maxTurns}`];
  }
}

function singleLine(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length > max || /[\r\n]/.test(value)) {
    throw new AgentDefinitionError(400, "bad_request", `${field} must be a single-line string (max ${max})`);
  }
  return value.trim();
}

/** Validates the editor payload shape. Meaning is validated by core afterwards. */
export function parseAgentDraft(input: unknown): AgentDefinitionDraft {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new AgentDefinitionError(400, "bad_request", "body must be an object");
  }
  const body = input as Record<string, unknown>;
  const description = body.description ?? "";
  if (typeof description !== "string" || description.length > 2_000) {
    throw new AgentDefinitionError(400, "bad_request", "description must be a string (max 2000)");
  }
  let tools: string[] | null = null;
  if (body.tools !== null && body.tools !== undefined) {
    if (
      !Array.isArray(body.tools) ||
      body.tools.length > 200 ||
      !body.tools.every((tool) => typeof tool === "string" && TOOL_NAME_RE.test(tool))
    ) {
      throw new AgentDefinitionError(400, "bad_request", "tools must be null or a list of tool names");
    }
    tools = [...new Set(body.tools as string[])];
  }
  if (body.mode !== "ask" && body.mode !== "edit") {
    throw new AgentDefinitionError(400, "bad_request", 'mode must be "ask" or "edit"');
  }
  let maxTurns: number | null = null;
  if (body.maxTurns !== null && body.maxTurns !== undefined) {
    if (typeof body.maxTurns !== "number" || !Number.isSafeInteger(body.maxTurns) || body.maxTurns < 1) {
      throw new AgentDefinitionError(400, "bad_request", "maxTurns must be null or a positive integer");
    }
    maxTurns = body.maxTurns;
  }
  const prompt = body.body ?? "";
  if (typeof prompt !== "string") throw new AgentDefinitionError(400, "bad_request", "body must be a string");
  const extraInput = body.extra ?? [];
  if (!Array.isArray(extraInput) || extraInput.length > 100) {
    throw new AgentDefinitionError(400, "bad_request", "extra must be a list of {key, value}");
  }
  const seen = new Set<string>();
  const extra = extraInput.map((field): AgentExtraField => {
    const { key, value } = (field ?? {}) as { key?: unknown; value?: unknown };
    if (typeof key !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) {
      throw new AgentDefinitionError(400, "bad_request", `invalid frontmatter key: ${String(key)}`);
    }
    const folded = key.toLowerCase();
    if (FORM_KEY_SET.has(folded) || seen.has(folded)) {
      throw new AgentDefinitionError(400, "bad_request", `frontmatter key given twice: ${key}`);
    }
    seen.add(folded);
    if (typeof value !== "string" || value.length > MAX_EXTRA_VALUE_CHARS || value.includes("\r")) {
      throw new AgentDefinitionError(
        400,
        "bad_request",
        `value of ${key} must be a string (max ${MAX_EXTRA_VALUE_CHARS})`,
      );
    }
    // A continuation line that starts a new top-level key (or closes the
    // block) would be read as a different field than the one edited here.
    for (const line of value.split("\n").slice(1)) {
      if ((line.trim() !== "" && !/^[\s#-]/.test(line)) || line.startsWith("---")) {
        throw new AgentDefinitionError(
          400,
          "bad_request",
          `continuation lines of ${key} must be indented, a "- " list item, or a comment`,
        );
      }
    }
    return { key, value };
  });
  return {
    name: singleLine(body.name ?? "", "name", 200),
    description: description.trim(),
    tools,
    mode: body.mode,
    model: singleLine(body.model ?? "", "model", 200),
    maxTurns,
    body: prompt.trim(),
    extra,
  };
}

/**
 * Renders a draft over the existing file (when there is one): form keys and
 * edited extras take their original positions, untouched entries keep their
 * exact lines, removed extras are dropped, and new keys are appended.
 */
export function renderAgentDefinition(draft: AgentDefinitionDraft, existing?: string): string {
  const previous = existing === undefined ? undefined : splitMarkdown(existing);
  const extras = new Map(draft.extra.map((field) => [field.key.toLowerCase(), field]));
  const written = new Set<string>();
  const lines: string[] = [...(previous?.preamble ?? [])];
  for (const entry of previous?.entries ?? []) {
    const folded = entry.key.toLowerCase();
    if (written.has(folded)) continue; // a duplicate key: core reads the last one, the form wrote it once
    if (FORM_KEY_SET.has(folded)) {
      lines.push(...renderFormKey(folded as (typeof FORM_KEYS)[number], draft));
      written.add(folded);
      continue;
    }
    const field = extras.get(folded);
    if (!field) continue;
    lines.push(
      ...(field.value === entryValueText(entry) && field.key === entry.key ? entry.lines : renderExtra(field)),
    );
    written.add(folded);
  }
  for (const key of FORM_KEYS) {
    if (!written.has(key)) lines.push(...renderFormKey(key, draft));
  }
  for (const field of draft.extra) {
    if (!written.has(field.key.toLowerCase())) lines.push(...renderExtra(field));
  }
  return `---\n${lines.join("\n")}\n---\n${draft.body === "" ? "" : `\n${draft.body}\n`}`;
}

function draftOf(scope: AgentDefinitionScope, id: string, markdown: string): AgentDefinitionDraft {
  let def: AgentDefinition;
  try {
    def = parseAgentMarkdown(scope, id, markdown);
  } catch (error) {
    throw new AgentDefinitionError(400, "bad_request", error instanceof Error ? error.message : String(error));
  }
  const split = splitMarkdown(markdown);
  const extra: AgentExtraField[] = [];
  const seen = new Set<string>();
  for (const entry of split.entries) {
    const folded = entry.key.toLowerCase();
    if (FORM_KEY_SET.has(folded) || seen.has(folded)) continue;
    seen.add(folded);
    extra.push({ key: entry.key, value: entryValueText(entry) });
  }
  return {
    name: def.name === id && !split.entries.some((entry) => entry.key.toLowerCase() === "name") ? "" : def.name,
    description: def.description,
    tools: def.tools ?? null,
    mode: def.mode,
    model: def.model ?? "",
    maxTurns: def.maxTurns ?? null,
    body: def.body ?? "",
    extra,
  };
}

export function readAgentDefinitionSource(
  workspace: string,
  scope: AgentDefinitionScope,
  id: string,
): AgentDefinitionSource {
  assertAgentId(id);
  const root = agentsRootOf(scope, workspace);
  const markdown = readProjectFile(root, relPath(id), MAX_AGENT_MARKDOWN_BYTES);
  if (markdown === undefined) throw new AgentDefinitionError(404, "not_found", `no ${scope} agent definition: ${id}`);
  return { id, scope, path: join(root, relPath(id)), ...draftOf(scope, id, markdown) };
}

/**
 * Writes one definition. `create` refuses to replace an existing file and
 * `update` refuses to create one, so a stale form never silently forks or
 * clobbers a definition. The caller holds the scope's coordination guard.
 */
export function writeAgentDefinition(
  workspace: string,
  scope: AgentDefinitionScope,
  id: string,
  draft: AgentDefinitionDraft,
  intent: "create" | "update",
): AgentDefinitionSource {
  assertAgentId(id);
  const root = agentsRootOf(scope, workspace);
  const rel = relPath(id);
  const existing = readProjectFile(root, rel, MAX_AGENT_MARKDOWN_BYTES);
  if (intent === "create" && existing !== undefined) {
    throw new AgentDefinitionError(409, "conflict", `a ${scope} agent named ${id} already exists`);
  }
  if (intent === "update" && existing === undefined) {
    throw new AgentDefinitionError(404, "not_found", `no ${scope} agent definition: ${id}`);
  }
  const markdown = renderAgentDefinition(draft, existing);
  if (Buffer.byteLength(markdown, "utf8") > MAX_AGENT_MARKDOWN_BYTES) {
    throw new AgentDefinitionError(400, "bad_request", `definition exceeds ${MAX_AGENT_MARKDOWN_BYTES} bytes`);
  }
  try {
    parseAgentMarkdown(scope, id, markdown);
  } catch (error) {
    throw new AgentDefinitionError(400, "bad_request", error instanceof Error ? error.message : String(error));
  }
  try {
    writeProjectFileAtomic(root, rel, markdown);
  } catch (error) {
    if (error instanceof ConfigValueError) throw new AgentDefinitionError(400, "bad_request", error.message);
    throw error;
  }
  const loaded = loadAgentDefinitionsFromDirs([{ scope, path: join(root, ".seekforge", "agents") }]).some(
    (def) => def.id === id,
  );
  if (!loaded) {
    // Put the previous state back rather than leave a file the loader skips.
    if (existing === undefined) removeProjectFile(root, rel);
    else writeProjectFileAtomic(root, rel, existing);
    throw new AgentDefinitionError(400, "bad_request", "the saved definition would not load; nothing was changed");
  }
  return readAgentDefinitionSource(workspace, scope, id);
}
