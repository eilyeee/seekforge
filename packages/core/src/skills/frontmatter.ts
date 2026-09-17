import { parseFrontmatter } from "../subagents/frontmatter.js";

/**
 * SKILL.md frontmatter, in the shape Claude Code writes it.
 *
 * Scalars come from the shared reader in subagents/frontmatter.ts. That reader
 * ignores YAML lists, and several skill fields (`allowed-tools`, `paths`, …)
 * are lists as often as they are strings, so the block and flow list forms are
 * read here. TODO(lane E): the shared reader is gaining list support; once it
 * lands, `readFrontmatterLists` should delegate to it.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const MAX_LIST_ITEMS = 256;

export type SkillFrontmatter = {
  /**
   * Raw scalar text per key, keys lower-cased. A flow list keeps its source
   * text here too (`argument-hint: [version]` is a hint, not a list); a block
   * list's key maps to "".
   */
  fields: Map<string, string>;
  /** List-valued fields (block `- item` or flow `[a, b]`), keys lower-cased. */
  lists: Map<string, string[]>;
  /** Body without the frontmatter block, trimmed. */
  body: string;
};

function unquote(value: string): string {
  const text = value.trim();
  if (text.startsWith('"')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      // fall through to the plain strip
    }
  }
  return text.replace(/^["']|["']$/g, "");
}

/** Split a flow sequence body on top-level commas, keeping quoted commas. */
function splitFlow(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: string | undefined;
  let depth = 0;
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  items.push(current);
  return items.map(unquote).filter((item) => item !== "");
}

function readFrontmatterLists(block: string): Map<string, string[]> {
  const lists = new Map<string, string[]>();
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!.trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      lists.set(key, splitFlow(value.slice(1, -1)).slice(0, MAX_LIST_ITEMS));
      continue;
    }
    if (value !== "") continue;
    const items: string[] = [];
    while (i + 1 < lines.length) {
      const item = /^\s*-\s+(.*)$/.exec(lines[i + 1]!);
      if (!item) {
        if (lines[i + 1]!.trim() === "") {
          i++;
          continue;
        }
        break;
      }
      i++;
      const text = unquote(item[1]!);
      if (text !== "" && items.length < MAX_LIST_ITEMS) items.push(text);
    }
    if (items.length > 0) lists.set(key, items);
  }
  return lists;
}

/** True when the markdown opens with a frontmatter block. */
export function hasFrontmatter(markdown: string): boolean {
  return FRONTMATTER_RE.test(markdown);
}

/**
 * Read SKILL.md. A file without frontmatter is all body; a malformed block is
 * reported by throwing, so a loader can refuse rather than guess.
 */
export function parseSkillFrontmatter(markdown: string): SkillFrontmatter {
  const match = FRONTMATTER_RE.exec(markdown);
  if (!match) return { fields: new Map(), lists: new Map(), body: markdown.trim() };
  const parsed = parseFrontmatter(markdown);
  return { fields: parsed.fields, lists: readFrontmatterLists(match[1]!), body: parsed.body };
}

/** A field that may be written as a list or as one delimited string. */
export function frontmatterList(
  fm: SkillFrontmatter,
  key: string,
  split: (raw: string) => string[],
): string[] | undefined {
  const list = fm.lists.get(key);
  if (list) return list;
  const raw = fm.fields.get(key);
  if (raw === undefined || raw.trim() === "") return undefined;
  return split(raw);
}

/** YAML booleans as Claude Code writes them; anything else is undefined. */
export function frontmatterBoolean(fm: SkillFrontmatter, key: string): boolean | undefined {
  const raw = fm.fields.get(key)?.trim().toLowerCase();
  if (raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "false" || raw === "no" || raw === "off") return false;
  return undefined;
}
