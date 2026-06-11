import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BUILTIN_AGENTS } from "./builtins.js";
import { AGENT_ID_RE, parseFrontmatter } from "./frontmatter.js";
import type { AgentDefinition, AgentScope } from "./types.js";

/** An agents root directory plus the scope its agents get. */
export type AgentsDir = { scope: AgentScope; path: string };

/**
 * Loads agent definitions from each root (`<root>/<id>/AGENT.md`), in order:
 * later dirs override earlier ones by id. Malformed agent dirs (bad
 * frontmatter, invalid id, missing AGENT.md) are skipped silently.
 */
export function loadAgentDefinitionsFromDirs(dirs: AgentsDir[]): AgentDefinition[] {
  const byId = new Map<string, AgentDefinition>();
  for (const dir of dirs) {
    for (const def of readAgentsRoot(dir)) byId.set(def.id, def);
  }
  return [...byId.values()];
}

/**
 * Merges the builtin agents at the LOWEST priority: any loaded definition
 * (global or project) with the same id replaces the builtin.
 */
export function withBuiltinAgents(defs: AgentDefinition[]): AgentDefinition[] {
  const byId = new Map<string, AgentDefinition>(BUILTIN_AGENTS.map((d) => [d.id, d]));
  for (const def of defs) byId.set(def.id, def);
  return [...byId.values()];
}

/**
 * Loads builtin + global (~/.seekforge/agents) + project (.seekforge/agents)
 * agent definitions; later scopes override earlier ones by id.
 */
export function loadAgentDefinitions(workspace: string): AgentDefinition[] {
  return withBuiltinAgents(
    loadAgentDefinitionsFromDirs([
      { scope: "global", path: path.join(os.homedir(), ".seekforge", "agents") },
      { scope: "project", path: path.join(workspace, ".seekforge", "agents") },
    ]),
  );
}

function readAgentsRoot({ scope, path: root }: AgentsDir): AgentDefinition[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const defs: AgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const def = readAgentDir(scope, entry.name, path.join(root, entry.name));
    if (def) defs.push(def);
  }
  return defs;
}

function readAgentDir(scope: AgentScope, id: string, dir: string): AgentDefinition | undefined {
  if (!AGENT_ID_RE.test(id)) return undefined;
  let markdown: string;
  try {
    markdown = fs.readFileSync(path.join(dir, "AGENT.md"), "utf8");
  } catch {
    return undefined;
  }
  try {
    return parseAgentMarkdown(scope, id, markdown);
  } catch {
    return undefined;
  }
}

/**
 * Parses our canonical AGENT.md: YAML frontmatter (name, description incl.
 * block scalars, trigger |-separated, tools comma-separated, own,
 * do_not_touch, boundary, mode, max-turns, model) + markdown body (appended to the
 * subagent prompt).
 */
export function parseAgentMarkdown(scope: AgentScope, id: string, markdown: string): AgentDefinition {
  const { fields, body } = parseFrontmatter(markdown);

  const tools = (fields.get("tools") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const triggers = (fields.get("trigger") ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);

  const maxTurnsRaw = fields.get("max-turns");
  const maxTurns = maxTurnsRaw !== undefined ? Number.parseInt(maxTurnsRaw, 10) : Number.NaN;

  return {
    id,
    scope,
    name: fields.get("name")?.trim() || id,
    description: (fields.get("description") ?? "").replace(/\s+/g, " ").trim(),
    triggers,
    tools: tools.length > 0 ? tools : undefined,
    mode: fields.get("mode") === "ask" ? "ask" : "edit",
    own: fields.get("own") || undefined,
    doNotTouch: fields.get("do_not_touch") || undefined,
    boundary: fields.get("boundary") || undefined,
    maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? maxTurns : undefined,
    model: fields.get("model")?.trim() || undefined,
    body: body || undefined,
  };
}
