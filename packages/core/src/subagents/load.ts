import * as fs from "node:fs";
import * as path from "node:path";
import { seekforgeHome } from "../memory/store.js";
import { readWorkspaceStateFile } from "../util/workspace-state.js";
import { loadPluginContributions } from "../plugins/index.js";
import { BUILTIN_AGENTS } from "./builtins.js";
import { parseExtendedAgentFields } from "./fields.js";
import { AGENT_ID_RE, frontmatterList, parseFrontmatter } from "./frontmatter.js";
import { parseExternalAgent } from "./import.js";
import { MAX_AGENT_DEFINITION_BYTES, type AgentDefinition, type AgentScope } from "./types.js";

export { MAX_AGENT_DEFINITION_BYTES };

/**
 * An agents root directory plus the scope its agents get. `format: "claude"`
 * reads Claude Code's flat `<root>/<name>.md` files instead of SeekForge's
 * `<root>/<id>/AGENT.md` directories.
 */
export type AgentsDir = { scope: AgentScope; path: string; format?: "seekforge" | "claude" };

/** Claude Code agent files read from one flat root; the rest are ignored. */
const MAX_CLAUDE_AGENT_FILES = 256;

/**
 * Loads agent definitions from each root, in order: later dirs override
 * earlier ones by id. Malformed definitions (bad frontmatter, invalid id,
 * missing AGENT.md) are skipped silently.
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
 * Loads builtin + global + project agent definitions; later scopes override
 * earlier ones by id. Within a scope, Claude Code's `.claude/agents/*.md`
 * load first so a SeekForge definition with the same id wins.
 */
export function loadAgentDefinitions(
  workspace: string,
  contributions = loadPluginContributions(workspace),
): AgentDefinition[] {
  const pluginRoots = contributions.agentRoots;
  const home = seekforgeHome();
  return withBuiltinAgents(
    loadAgentDefinitionsFromDirs([
      ...pluginRoots.map((path) => ({ scope: "global" as const, path })),
      { scope: "global", path: path.join(home, ".claude", "agents"), format: "claude" },
      { scope: "global", path: path.join(home, ".seekforge", "agents") },
      { scope: "project", path: path.join(workspace, ".claude", "agents"), format: "claude" },
      { scope: "project", path: path.join(workspace, ".seekforge", "agents") },
    ]),
  );
}

function readAgentsRoot({ scope, path: root, format }: AgentsDir): AgentDefinition[] {
  let entries: fs.Dirent[];
  let physicalRoot: string;
  let rootIdentity: fs.Stats;
  try {
    const lexicalRoot = path.resolve(root);
    const stat = fs.lstatSync(lexicalRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return [];
    const parentStat = fs.lstatSync(path.dirname(lexicalRoot));
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) return [];
    physicalRoot = fs.realpathSync(lexicalRoot);
    rootIdentity = fs.statSync(physicalRoot);
    entries = fs.readdirSync(physicalRoot, { withFileTypes: true });
    const currentRoot = fs.statSync(physicalRoot);
    if (!sameIdentity(rootIdentity, currentRoot) || fs.realpathSync(physicalRoot) !== physicalRoot) return [];
  } catch {
    return [];
  }
  const defs: AgentDefinition[] = [];
  if (format === "claude") {
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_CLAUDE_AGENT_FILES);
    for (const name of files) {
      const def = readClaudeAgentFile(scope, name, physicalRoot, rootIdentity);
      if (def) defs.push(def);
    }
    return defs;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const def = readAgentDir(scope, entry.name, physicalRoot, rootIdentity);
    if (def) defs.push(def);
  }
  return defs;
}

function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readBoundedDefinition(root: string, rootIdentity: fs.Stats, relPath: string): string | undefined {
  try {
    if (!sameIdentity(rootIdentity, fs.statSync(root))) return undefined;
    const source = readWorkspaceStateFile(root, relPath, MAX_AGENT_DEFINITION_BYTES);
    if (source === undefined || !sameIdentity(rootIdentity, fs.statSync(root))) return undefined;
    return source;
  } catch {
    return undefined;
  }
}

function readAgentDir(
  scope: AgentScope,
  id: string,
  root: string,
  rootIdentity: fs.Stats,
): AgentDefinition | undefined {
  if (!AGENT_ID_RE.test(id)) return undefined;
  const markdown = readBoundedDefinition(root, rootIdentity, path.join(id, "AGENT.md"));
  if (markdown === undefined) return undefined;
  try {
    return parseAgentMarkdown(scope, id, markdown);
  } catch {
    return undefined;
  }
}

function readClaudeAgentFile(
  scope: AgentScope,
  fileName: string,
  root: string,
  rootIdentity: fs.Stats,
): AgentDefinition | undefined {
  const markdown = readBoundedDefinition(root, rootIdentity, fileName);
  if (markdown === undefined) return undefined;
  try {
    const { def } = parseExternalAgent(markdown, { fallbackName: fileName.slice(0, -".md".length) });
    // Repository-controlled files never carry hooks; parseExternalAgent keeps
    // them because an import may target the user's own scope.
    const { hooks, ...rest } = def;
    return { ...rest, ...(hooks !== undefined && scope !== "project" ? { hooks } : {}), scope };
  } catch {
    return undefined;
  }
}

/**
 * Parses our canonical AGENT.md: YAML frontmatter (name, description incl.
 * block scalars, trigger |-separated or a list, tools comma-separated or a
 * list, own, do_not_touch, boundary, mode, max-turns, model, plus the Claude
 * Code fields in fields.ts) + markdown body (appended to the subagent prompt).
 */
export function parseAgentMarkdown(scope: AgentScope, id: string, markdown: string): AgentDefinition {
  const parsed = parseFrontmatter(markdown);
  const { fields, body } = parsed;

  const tools = frontmatterList(parsed, "tools");
  const triggers = frontmatterList(parsed, "trigger", "|") ?? [];

  const modeRaw = fields.get("mode")?.trim();
  if (modeRaw !== undefined && modeRaw !== "ask" && modeRaw !== "edit") {
    throw new Error(`invalid subagent mode: ${modeRaw || "(empty)"}`);
  }
  const maxTurnsRaw = fields.get("max-turns") ?? fields.get("maxturns");
  let maxTurns: number | undefined;
  if (maxTurnsRaw !== undefined) {
    const normalized = maxTurnsRaw.trim();
    if (!/^[1-9]\d*$/.test(normalized)) {
      throw new Error(`invalid subagent max-turns: ${maxTurnsRaw}`);
    }
    maxTurns = Number(normalized);
    if (!Number.isSafeInteger(maxTurns)) {
      throw new Error(`invalid subagent max-turns: ${maxTurnsRaw}`);
    }
  }
  const extended = parseExtendedAgentFields(parsed, scope);

  return {
    id,
    scope,
    name: fields.get("name")?.trim() || id,
    description: (fields.get("description") ?? "").replace(/\s+/g, " ").trim(),
    triggers,
    tools,
    // A plan-mode agent is read-only whatever `mode` says.
    mode: extended.permissionMode === "plan" ? "ask" : (modeRaw ?? "edit"),
    own: fields.get("own") || undefined,
    doNotTouch: fields.get("do_not_touch") || undefined,
    boundary: fields.get("boundary") || undefined,
    maxTurns,
    model: fields.get("model")?.trim() || undefined,
    ...extended,
    body: body || undefined,
  };
}
