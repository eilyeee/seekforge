import * as fs from "node:fs";
import * as path from "node:path";
import { readUtf8FileBoundedSync, writeFileAtomic } from "../util/fs.js";
import { resolveInsideWorkspace } from "../tools/sandbox.js";
import { mapAgentToolList, parseExtendedAgentFields } from "./fields.js";
import { AGENT_ID_RE, frontmatterList, kebabize, parseFrontmatter } from "./frontmatter.js";
import { MAX_AGENT_DEFINITION_BYTES, type AgentDefinition } from "./types.js";

/**
 * Importing external agent definitions (Claude Code / Meta_Kim-style agent
 * .md with YAML frontmatter) into SeekForge's AGENT.md layout. The same
 * parser reads `.claude/agents/*.md` in place (see load.ts).
 *
 * Imported agents are prompt material only — they never grant permissions;
 * dispatching an edit-mode agent still goes through the normal approval flow.
 */

/** Claude Code's model aliases name Anthropic tiers, not a model this provider can serve. */
const CLAUDE_MODEL_ALIASES: ReadonlySet<string> = new Set(["inherit", "sonnet", "opus", "haiku", "opusplan"]);

export type ParsedExternalAgent = {
  def: Omit<AgentDefinition, "scope">;
  /** External tool names that have no SeekForge equivalent (dropped). */
  droppedTools: string[];
};

export type ParseExternalAgentOptions = {
  /** Identifier used when the frontmatter has no usable `name` (a file's stem). */
  fallbackName?: string;
};

/**
 * Parses a Claude Code or Meta_Kim-style agent markdown. Frontmatter keys:
 * name, description, tools / disallowedTools (comma list or YAML list, Claude
 * tool names mapped), model, maxTurns, permissionMode, isolation, skills,
 * effort, color, mcpServers, hooks, and Meta_Kim's own, do_not_touch,
 * boundary, trigger, type. The body is the agent's prompt.
 *
 * mode rule: "ask" when permissionMode is plan, `type` contains
 * "meta"/"governance", or the body contains "executionBlock=true" or
 * "NOT FOR DIRECT EXECUTION"; else "edit".
 */
export function parseExternalAgent(markdown: string, options: ParseExternalAgentOptions = {}): ParsedExternalAgent {
  const parsed = parseFrontmatter(markdown);
  const { fields, body } = parsed;

  let rawName = fields.get("name") ?? "";
  let id = kebabize(rawName);
  if (!AGENT_ID_RE.test(id) && options.fallbackName !== undefined) {
    rawName = rawName.trim() || options.fallbackName;
    id = kebabize(options.fallbackName);
  }
  if (!AGENT_ID_RE.test(id)) {
    throw new Error(`not an importable agent: frontmatter "name" is missing or invalid (${rawName || "empty"})`);
  }

  const extended = parseExtendedAgentFields(parsed, "external");
  const type = (fields.get("type") ?? "") + " " + (fields.get("subagent_type") ?? "");
  const governanceType = /meta|governance/i.test(type);
  const executionBlocked = body.includes("executionBlock=true") || body.includes("NOT FOR DIRECT EXECUTION");
  const mode: "ask" | "edit" =
    governanceType || executionBlocked || extended.permissionMode === "plan" ? "ask" : "edit";

  const toolsField = frontmatterList(parsed, "tools");
  const { tools, dropped: droppedTools } = mapAgentToolList(toolsField ?? []);

  const triggers = frontmatterList(parsed, "trigger", "|") ?? [];
  const model = oneLine(fields.get("model"));
  const maxTurnsRaw = (fields.get("maxturns") ?? fields.get("max-turns"))?.trim();
  const maxTurns = maxTurnsRaw !== undefined && /^[1-9]\d{0,5}$/.test(maxTurnsRaw) ? Number(maxTurnsRaw) : undefined;

  return {
    def: {
      id,
      name: rawName.trim(),
      description: (fields.get("description") ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
      triggers,
      // Preserve an explicit empty whitelist. Treating "all declared tools were
      // unsupported" as undefined would grant every SeekForge tool instead.
      tools: toolsField === undefined ? undefined : tools,
      mode,
      own: oneLine(fields.get("own")),
      doNotTouch: oneLine(fields.get("do_not_touch")),
      boundary: oneLine(fields.get("boundary")),
      model: model !== undefined && CLAUDE_MODEL_ALIASES.has(model.toLowerCase()) ? undefined : model,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...extended,
      body: body || undefined,
    },
    droppedTools,
  };
}

function oneLine(value: string | undefined): string | undefined {
  const v = value?.replace(/\s+/g, " ").trim();
  return v || undefined;
}

/** Renders our canonical AGENT.md frontmatter for a definition. */
export function renderAgentMarkdown(def: Omit<AgentDefinition, "scope">): string {
  const lines: string[] = ["---"];
  const push = (key: string, value: string | undefined): void => {
    if (value === undefined || value === "") return;
    lines.push(`${key}: ${JSON.stringify(value)}`);
  };
  const pushList = (key: string, value: readonly string[] | undefined): void => {
    if (value !== undefined) lines.push(`${key}: ${JSON.stringify(value.join(", "))}`);
  };
  push("name", def.name);
  push("description", def.description);
  push("trigger", def.triggers.join(" | ") || undefined);
  pushList("tools", def.tools);
  pushList("disallowedTools", def.disallowedTools);
  push("mode", def.mode);
  push("permissionMode", def.permissionMode);
  push("isolation", def.isolation);
  pushList("skills", def.skills);
  push("effort", def.effort);
  push("color", def.color);
  pushList("mcpServers", def.mcpServers);
  if (def.hooks !== undefined) lines.push(`hooks: ${JSON.stringify(def.hooks)}`);
  push("own", def.own);
  push("do_not_touch", def.doNotTouch);
  push("boundary", def.boundary);
  push("model", def.model);
  if (def.maxTurns !== undefined) lines.push(`max-turns: ${def.maxTurns}`);
  lines.push("---");
  lines.push("");
  if (def.body) lines.push(def.body);
  return `${lines.join("\n").trimEnd()}\n`;
}

export type ImportAgentOptions = {
  /** Agents root to write into (e.g. <ws>/.seekforge/agents or ~/.seekforge/agents). */
  targetRoot: string;
  /** Replace an existing agent with the same id. */
  force?: boolean;
};

/**
 * Imports a Claude Code / Meta_Kim-style agent .md file into targetRoot as
 * `<targetRoot>/<id>/AGENT.md` in our canonical format (regenerated
 * frontmatter + original body). Returns the created directory, the external
 * tool names that were dropped, and the fields an import never carries.
 *
 * An import is how a file of unknown origin becomes a trusted definition, so
 * it keeps only what tightens: hooks and a looser-than-default permissionMode
 * are dropped (`droppedFields`); the user adds them to their own file by hand.
 */
export function importExternalAgent(
  sourcePath: string,
  opts: ImportAgentOptions,
): { dir: string; agent: Omit<AgentDefinition, "scope">; droppedTools: string[]; droppedFields: string[] } {
  const source = fs.realpathSync(sourcePath);
  const parsed = parseExternalAgent(readUtf8FileBoundedSync(source, MAX_AGENT_DEFINITION_BYTES), {
    fallbackName: path.basename(source).replace(/\.md$/i, ""),
  });
  const { droppedTools } = parsed;
  const { hooks, permissionMode, ...kept } = parsed.def;
  const droppedFields: string[] = [];
  if (hooks !== undefined) droppedFields.push("hooks");
  const loosening = permissionMode === "acceptEdits" || permissionMode === "bypassPermissions";
  if (loosening) droppedFields.push("permissionMode");
  const def: Omit<AgentDefinition, "scope"> = {
    ...kept,
    ...(permissionMode !== undefined && !loosening ? { permissionMode } : {}),
  };

  fs.mkdirSync(opts.targetRoot, { recursive: true });
  const requestedDir = path.join(opts.targetRoot, def.id);
  if (fs.existsSync(requestedDir) && fs.lstatSync(requestedDir).isSymbolicLink()) {
    throw new Error(`refusing symlinked agent directory: ${requestedDir}`);
  }
  const resolvedDir = resolveInsideWorkspace(opts.targetRoot, def.id);
  if (fs.existsSync(resolvedDir) && !opts.force) {
    throw new Error(`agent already exists: ${requestedDir} (use --force to replace)`);
  }
  fs.mkdirSync(resolvedDir, { recursive: true });
  const requestedFile = path.join(requestedDir, "AGENT.md");
  if (fs.existsSync(requestedFile) && fs.lstatSync(requestedFile).isSymbolicLink()) {
    throw new Error(`refusing symlinked agent file: ${requestedFile}`);
  }
  const target = resolveInsideWorkspace(opts.targetRoot, path.join(def.id, "AGENT.md"));
  writeFileAtomic(target, renderAgentMarkdown(def));
  return { dir: requestedDir, agent: def, droppedTools, droppedFields };
}
