import * as path from "node:path";
import type { PermissionRule } from "@seekforge/shared";

/**
 * Tool entries in `allowed-tools` / `disallowed-tools` and plugin hook
 * matchers, translated into SeekForge permission rules.
 *
 * Two dialects share one list. A Claude Code name (`Bash`, `Edit`, …) carries
 * Claude Code's meaning; a SeekForge tool name (`run_command`, …) carries
 * SeekForge's. The difference matters for the argument: `Bash(npm test)` is an
 * EXACT command in Claude Code, and SeekForge rules can only say "this prefix,
 * on a word boundary" — so an allow entry of that shape would widen what the
 * author granted. Such entries are refused for allow and over-approximated for
 * deny, because a deny that matches too much fails closed.
 */

/** Claude Code tool names → the SeekForge tools that do the same job. */
const CLAUDE_TOOL_NAMES: Readonly<Record<string, readonly string[]>> = {
  bash: ["run_command"],
  bashoutput: ["task_output"],
  killshell: ["task_kill"],
  killbash: ["task_kill"],
  read: ["read_file", "notebook_read"],
  write: ["write_file"],
  edit: ["apply_patch"],
  multiedit: ["apply_patch"],
  notebookedit: ["notebook_edit"],
  notebookread: ["notebook_read"],
  glob: ["glob", "list_files"],
  ls: ["list_files"],
  grep: ["search_text"],
  webfetch: ["web_fetch"],
  websearch: ["web_search"],
  todowrite: ["update_plan"],
  askuserquestion: ["ask_user"],
  skill: ["invoke_skill"],
};

/** Tools whose rule `match` is a shell command (word-boundary prefix). */
const COMMAND_TOOLS = new Set(["run_command", "task_kill"]);
/** Tools whose rule `match` is a path (segment-boundary prefix). */
const PATH_TOOLS = new Set([
  "read_file",
  "write_file",
  "apply_patch",
  "list_files",
  "search_text",
  "notebook_read",
  "notebook_edit",
]);

const SEEKFORGE_TOOL_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MCP_TOOL_RE = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;
const MAX_TOOL_ENTRIES = 64;
const MAX_TOOL_ENTRY_CHARS = 300;

/**
 * Map one tool name to SeekForge names. Unknown names yield an empty list —
 * the caller decides whether that is an error.
 */
export function mapToolName(name: string): string[] {
  const trimmed = name.trim();
  const claude = CLAUDE_TOOL_NAMES[trimmed.toLowerCase()];
  // A lower-case SeekForge name such as `glob` also appears in the Claude
  // table; only a capitalized spelling is read as Claude Code's.
  if (claude && trimmed !== trimmed.toLowerCase()) return [...claude];
  if (trimmed === "*" || SEEKFORGE_TOOL_RE.test(trimmed) || MCP_TOOL_RE.test(trimmed)) return [trimmed];
  return claude ? [...claude] : [];
}

/**
 * Split a frontmatter tool list. Commas separate entries; so does whitespace
 * outside parentheses, which is how `Bash(git add:*) Bash(git status)` reads.
 */
export function splitToolList(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  const flush = (): void => {
    const entry = current.trim();
    if (entry !== "") out.push(entry);
    current = "";
  };
  for (const ch of raw) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "," || /\s/.test(ch))) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return out;
}

export type ToolEntry = { raw: string; tool: string; spec?: string };

/** Parse `Name` / `Name(spec)`; throws on anything else. */
export function parseToolEntry(raw: string): ToolEntry {
  const text = raw.trim();
  if (text === "" || text.length > MAX_TOOL_ENTRY_CHARS) throw new Error(`invalid tool entry "${raw}"`);
  const match = /^([A-Za-z*][A-Za-z0-9_*-]*)(?:\((.*)\))?$/s.exec(text);
  if (!match) throw new Error(`invalid tool entry "${raw}"`);
  const spec = match[2]?.trim();
  return { raw: text, tool: match[1]!, ...(spec !== undefined && spec !== "" ? { spec } : {}) };
}

export type TranslatedToolRules = {
  rules: PermissionRule[];
  /** Human-readable reasons an entry was dropped or widened. */
  notes: string[];
};

type Subject = { kind: "command" | "path"; prefix: string } | { kind: "any" } | { kind: "unsupported" };

function commandSubject(spec: string, claude: boolean): Subject {
  // Claude Code's prefix forms: `git add:*` and `git add *`.
  const prefixForm = /^(.*?)(?::\*| \*)$/s.exec(spec);
  if (prefixForm) {
    const prefix = prefixForm[1]!.trim();
    if (prefix === "" || prefix.includes("*")) return { kind: "unsupported" };
    return { kind: "command", prefix };
  }
  if (spec.includes("*")) return { kind: "unsupported" };
  // An exact Claude Code command cannot be said with a prefix rule.
  return claude ? { kind: "unsupported" } : { kind: "command", prefix: spec };
}

function pathSubject(spec: string): Subject {
  let value = spec.trim();
  if (value.startsWith("/") || value.startsWith("~") || value.includes("\\")) return { kind: "unsupported" };
  if (value.startsWith("./")) value = value.slice(2);
  if (value === "**" || value === "*") return { kind: "any" };
  if (value.endsWith("/**")) value = `${value.slice(0, -3)}/`;
  if (value.includes("*") || value.includes("?") || value.includes("[")) return { kind: "unsupported" };
  const normalized = path.posix.normalize(value);
  if (normalized === ".." || normalized.startsWith("../") || normalized === "." || normalized === "") {
    return { kind: "unsupported" };
  }
  return { kind: "path", prefix: normalized };
}

/**
 * Translate a skill's tool list into rules of one action.
 *
 * `allow` refuses anything it cannot say exactly (the entry is dropped with a
 * note: the user is simply asked as usual). `deny` widens instead: an entry it
 * cannot say exactly denies the whole tool. `workspace`, when given, adds an
 * absolute twin of every path deny, because a path rule is matched against the
 * path the model typed and the model may type it either way.
 */
export function translateToolRules(
  entries: readonly string[],
  action: "allow" | "deny",
  workspace?: string,
): TranslatedToolRules {
  const rules: PermissionRule[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const push = (rule: PermissionRule): void => {
    const key = `${rule.action}\0${rule.tool}\0${rule.match ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    rules.push(rule);
  };
  for (const raw of entries.slice(0, MAX_TOOL_ENTRIES)) {
    let entry: ToolEntry;
    try {
      entry = parseToolEntry(raw);
    } catch (error) {
      notes.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const tools = mapToolName(entry.tool);
    if (tools.length === 0) {
      notes.push(`unknown tool "${entry.tool}" in "${entry.raw}" was ignored`);
      continue;
    }
    const claude = tools[0] !== entry.tool;
    for (const tool of tools) {
      if (entry.spec === undefined) {
        push({ action, tool });
        continue;
      }
      const subject = COMMAND_TOOLS.has(tool)
        ? commandSubject(entry.spec, claude)
        : PATH_TOOLS.has(tool)
          ? pathSubject(entry.spec)
          : ({ kind: "unsupported" } as const);
      if (subject.kind === "any") {
        push({ action, tool });
      } else if (subject.kind === "command") {
        push({ action, tool, match: subject.prefix });
      } else if (subject.kind === "path") {
        push({ action, tool, match: subject.prefix });
        if (action === "deny" && workspace !== undefined) {
          push({ action, tool, match: path.join(workspace, subject.prefix) });
        }
      } else if (action === "deny") {
        push({ action, tool });
        notes.push(`"${entry.raw}" cannot be expressed exactly; all ${tool} calls are denied instead`);
      } else {
        notes.push(`"${entry.raw}" cannot be expressed exactly and was not pre-approved`);
      }
    }
  }
  if (entries.length > MAX_TOOL_ENTRIES) notes.push(`only the first ${MAX_TOOL_ENTRIES} tool entries were read`);
  return { rules, notes };
}

/**
 * Tool names a hook matcher selects, or undefined when the matcher is not a
 * plain alternation of names (`Write|Edit`) and cannot be translated.
 */
export function hookMatcherTools(matcher: string | undefined): string[] | undefined {
  const text = (matcher ?? "").trim();
  if (text === "" || text === "*" || text === ".*") return ["*"];
  const names = text.split("|").map((part) => part.trim());
  if (names.some((name) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(name) && !MCP_TOOL_RE.test(name))) return undefined;
  const tools = new Set<string>();
  for (const name of names) {
    const mapped = mapToolName(name);
    if (mapped.length === 0) return undefined;
    for (const tool of mapped) tools.add(tool);
  }
  return [...tools];
}
