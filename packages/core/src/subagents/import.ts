import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_ID_RE, kebabize, parseFrontmatter } from "./frontmatter.js";
import type { AgentDefinition } from "./types.js";

/**
 * Importing external agent definitions (Claude-Code / Meta_Kim-style agent
 * .md with YAML frontmatter) into SeekForge's AGENT.md layout.
 *
 * Imported agents are prompt material only — they never grant permissions;
 * dispatching an edit-mode agent still goes through the normal approval flow.
 */

/** Claude-style tool names → SeekForge builtin tool names. */
const TOOL_NAME_MAP: Record<string, string> = {
  read: "read_file",
  grep: "search_text",
  glob: "list_files",
  bash: "run_command",
  webfetch: "web_fetch",
};

/** Our own tool names pass through unchanged when listed directly. */
const KNOWN_TOOLS = new Set([
  "read_file",
  "write_file",
  "apply_patch",
  "list_files",
  "search_text",
  "run_command",
  "git_status",
  "git_diff",
  "git_commit",
  "update_plan",
  "detect_project",
  "list_scripts",
  "web_fetch",
]);

export type ParsedExternalAgent = {
  def: Omit<AgentDefinition, "scope">;
  /** External tool names that have no SeekForge equivalent (dropped). */
  droppedTools: string[];
};

/**
 * Parses a Meta_Kim-style agent markdown (frontmatter keys: name,
 * description, tools comma list, own, do_not_touch, boundary, trigger, type).
 *
 * mode rule: "ask" when `type` contains "meta"/"governance" OR the body
 * contains "executionBlock=true" or "NOT FOR DIRECT EXECUTION"; else "edit".
 */
export function parseExternalAgent(markdown: string): ParsedExternalAgent {
  const { fields, body } = parseFrontmatter(markdown);

  const rawName = fields.get("name") ?? "";
  const id = kebabize(rawName);
  if (!AGENT_ID_RE.test(id)) {
    throw new Error(`not an importable agent: frontmatter "name" is missing or invalid (${rawName || "empty"})`);
  }

  const type = (fields.get("type") ?? "") + " " + (fields.get("subagent_type") ?? "");
  const governanceType = /meta|governance/i.test(type);
  const executionBlocked = body.includes("executionBlock=true") || body.includes("NOT FOR DIRECT EXECUTION");
  const mode: "ask" | "edit" = governanceType || executionBlocked ? "ask" : "edit";

  const tools: string[] = [];
  const droppedTools: string[] = [];
  for (const raw of (fields.get("tools") ?? "").split(",")) {
    const name = raw.trim();
    if (!name) continue;
    const mapped = TOOL_NAME_MAP[name.toLowerCase()] ?? (KNOWN_TOOLS.has(name) ? name : undefined);
    if (mapped) {
      if (!tools.includes(mapped)) tools.push(mapped);
    } else {
      droppedTools.push(name);
    }
  }

  const triggers = (fields.get("trigger") ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    def: {
      id,
      name: rawName.trim(),
      description: (fields.get("description") ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
      triggers,
      tools: tools.length > 0 ? tools : undefined,
      mode,
      own: oneLine(fields.get("own")),
      doNotTouch: oneLine(fields.get("do_not_touch")),
      boundary: oneLine(fields.get("boundary")),
      model: oneLine(fields.get("model")),
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
  push("name", def.name);
  push("description", def.description);
  push("trigger", def.triggers.join(" | ") || undefined);
  push("tools", def.tools?.join(", "));
  push("mode", def.mode);
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
 * Imports a Meta_Kim-style agent .md file into targetRoot as
 * `<targetRoot>/<id>/AGENT.md` in our canonical format (regenerated
 * frontmatter + original body). Returns the created directory and the
 * external tool names that were dropped.
 */
export function importExternalAgent(
  sourcePath: string,
  opts: ImportAgentOptions,
): { dir: string; agent: Omit<AgentDefinition, "scope">; droppedTools: string[] } {
  const { def, droppedTools } = parseExternalAgent(fs.readFileSync(sourcePath, "utf8"));

  const dir = path.join(opts.targetRoot, def.id);
  if (fs.existsSync(dir) && !opts.force) {
    throw new Error(`agent already exists: ${dir} (use --force to replace)`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENT.md"), renderAgentMarkdown(def));
  return { dir, agent: def, droppedTools };
}
