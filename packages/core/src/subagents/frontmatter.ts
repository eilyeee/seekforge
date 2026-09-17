/**
 * Minimal YAML-frontmatter reader shared by the agent loader, the agent and
 * skill importers, and user commands.
 *
 * Supported subset: `key: value`, quoted values, `key: |` / `key: >` block
 * scalars, lists (block `- item`, including the indentless form at the key's
 * own column, and flow `[a, b]`), and nested maps (block, or flow `{a: b}` /
 * JSON). Anchors, tags, multi-document streams and multi-line flow
 * collections are not supported. Every scalar stays a string; consumers
 * decide what "true" or "12" mean.
 *
 * `fields` is the historical flat view and keeps its exact old behavior for
 * scalars; a list value appears there joined with ", " so comma-splitting
 * consumers keep working. `values` carries the structured value.
 */

export type FrontmatterValue = string | FrontmatterValue[] | FrontmatterMap;
export type FrontmatterMap = { [key: string]: FrontmatterValue };

export type ParsedFrontmatter = {
  /** Flat scalar view by lowercased top-level key (lists joined with ", "). */
  fields: Map<string, string>;
  /** Structured value by lowercased top-level key; nested map keys keep their case. */
  values: Map<string, FrontmatterValue>;
  /** Markdown body without the frontmatter block. */
  body: string;
};

type Line = { indent: number; text: string };

const TOP_LEVEL_KEY_RE = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/;
const NESTED_KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#[\]{},][^:]*?)\s*:(?=\s|$)\s*(.*)$/;
const BLOCK_SCALAR_RE = /^[|>][+-]?$/;
/** Keys that would reach Object.prototype through a plain-object assignment. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** Nesting bound: frontmatter is small, and recursion depth must stay bounded. */
const MAX_DEPTH = 16;

export function parseFrontmatter(markdown: string): ParsedFrontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown);
  if (!m) {
    throw new Error("missing YAML frontmatter (--- ... ---)");
  }
  const [, fm, body] = m as unknown as [string, string, string];

  const fields = new Map<string, string>();
  const values = new Map<string, FrontmatterValue>();
  const lines = fm.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const kv = TOP_LEVEL_KEY_RE.exec(line);
    if (!kv) continue;
    const key = (kv[1] as string).toLowerCase();
    const raw = (kv[2] as string).trim();
    if (BLOCK_SCALAR_RE.test(raw)) {
      // Block scalar (incl. chomping indicators |-, |+, >-, >+): consume the
      // indented lines that follow. Top-level blocks fold to one line, as they
      // always have.
      const block: string[] = [];
      while (
        i + 1 < lines.length &&
        (/^\s+\S/.test(lines[i + 1] as string) || (lines[i + 1] as string).trim() === "")
      ) {
        i++;
        block.push((lines[i] as string).trim());
      }
      const value = block.join(" ").trim();
      fields.set(key, value);
      values.set(key, value);
      continue;
    }
    if (raw === "") {
      // A nested block: indented lines, blank lines, and an indentless
      // sequence (`- item` at column 0) all belong to this key.
      const nested: Line[] = [];
      while (i + 1 < lines.length) {
        const next = (lines[i + 1] as string).replace(/\r$/, "");
        const trimmed = next.trim();
        const indent = next.length - next.trimStart().length;
        if (trimmed === "" || trimmed.startsWith("#")) {
          i++;
          continue;
        }
        if (indent === 0 && !isDashItem(trimmed)) break;
        i++;
        nested.push({ indent, text: trimmed });
      }
      if (nested.length === 0) {
        fields.set(key, "");
        values.set(key, "");
        continue;
      }
      const value = parseBlock(nested, 0, (nested[0] as Line).indent, 0).value;
      values.set(key, value);
      // A block map has no flat form; it stays "" as it always read.
      fields.set(key, typeof value === "string" ? value : Array.isArray(value) ? joinList(value) : "");
      continue;
    }
    if (raw.startsWith("[")) {
      const list = parseFlowSequence(raw, 0);
      if (list !== undefined) {
        values.set(key, list);
        fields.set(key, joinList(list));
        continue;
      }
    }
    if (raw.startsWith("{")) {
      const map = parseFlowMap(raw, 0);
      if (map !== undefined) {
        values.set(key, map);
        fields.set(key, raw);
        continue;
      }
    }
    const value = legacyScalar(raw);
    fields.set(key, value);
    values.set(key, value);
  }

  return { fields, values, body: body.trim() };
}

/**
 * A top-level key read as a list: a YAML list yields its string items, a
 * scalar is split on `separator` (the historical comma/pipe form). Absent key
 * = undefined; a map, or a list of only non-strings, = [].
 */
export function frontmatterList(
  parsed: Pick<ParsedFrontmatter, "values">,
  key: string,
  separator: string | RegExp = ",",
): string[] | undefined {
  const value = parsed.values.get(key.toLowerCase());
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    return value
      .split(separator)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === "string" && item.trim() !== "" ? [item.trim()] : []));
}

function joinList(list: FrontmatterValue[]): string {
  return list.filter((item): item is string => typeof item === "string").join(", ");
}

function isDashItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

function parseBlock(
  lines: Line[],
  start: number,
  indent: number,
  depth: number,
): { value: FrontmatterValue; next: number } {
  if (depth > MAX_DEPTH) return { value: "", next: skipDeeper(lines, start, indent - 1) };
  const first = lines[start] as Line;
  if (isDashItem(first.text)) return parseSequence(lines, start, indent, depth);
  if (NESTED_KEY_RE.test(first.text)) return parseMapping(lines, start, indent, depth);
  // A multi-line plain scalar: fold its lines into one.
  const next = skipDeeper(lines, start + 1, indent - 1);
  const folded = lines
    .slice(start, next)
    .map((line) => line.text)
    .join(" ");
  return { value: legacyScalar(folded.trim()), next };
}

/** Index of the first line at or after `start` that is not indented past `indent`. */
function skipDeeper(lines: Line[], start: number, indent: number): number {
  let i = start;
  while (i < lines.length && (lines[i] as Line).indent > indent) i++;
  return i;
}

function parseSequence(
  lines: Line[],
  start: number,
  indent: number,
  depth: number,
): { value: FrontmatterValue[]; next: number } {
  const items: FrontmatterValue[] = [];
  let i = start;
  while (i < lines.length && (lines[i] as Line).indent === indent && isDashItem((lines[i] as Line).text)) {
    const text = (lines[i] as Line).text;
    const rest = text.slice(1).trimStart();
    const restIndent = indent + (text.length - rest.length);
    if (rest === "") {
      i++;
      if (i < lines.length && (lines[i] as Line).indent > indent) {
        const nested = parseBlock(lines, i, (lines[i] as Line).indent, depth + 1);
        items.push(nested.value);
        i = nested.next;
      } else {
        items.push("");
      }
      continue;
    }
    if (isDashItem(rest) || (NESTED_KEY_RE.test(rest) && !rest.startsWith("[") && !rest.startsWith("{"))) {
      // `- key: value` opens a map whose later keys align with `key`; `- - x`
      // opens a nested sequence the same way. Re-home the remainder at its own
      // column and parse it as a block.
      const rehomed = lines.slice();
      rehomed[i] = { indent: restIndent, text: rest };
      const nested = parseBlock(rehomed, i, restIndent, depth + 1);
      items.push(nested.value);
      i = nested.next;
      continue;
    }
    if (BLOCK_SCALAR_RE.test(rest)) {
      const block = collectBlockScalar(lines, i + 1, indent, rest);
      items.push(block.value);
      i = block.next;
      continue;
    }
    items.push(parseScalar(rest, depth));
    i++;
  }
  return { value: items, next: i };
}

function parseMapping(
  lines: Line[],
  start: number,
  indent: number,
  depth: number,
): { value: FrontmatterMap; next: number } {
  const map: FrontmatterMap = {};
  let i = start;
  while (i < lines.length && (lines[i] as Line).indent === indent) {
    const kv = NESTED_KEY_RE.exec((lines[i] as Line).text);
    if (!kv) break;
    const key = unquoteKey(kv[1] as string);
    const rest = (kv[2] as string).trim();
    i++;
    let value: FrontmatterValue;
    if (rest === "") {
      const next = lines[i];
      if (next && (next.indent > indent || (next.indent === indent && isDashItem(next.text)))) {
        const nested = parseBlock(lines, i, next.indent, depth + 1);
        value = nested.value;
        i = nested.next;
      } else {
        value = "";
      }
    } else if (BLOCK_SCALAR_RE.test(rest)) {
      const block = collectBlockScalar(lines, i, indent, rest);
      value = block.value;
      i = block.next;
    } else {
      value = parseScalar(rest, depth);
    }
    if (!UNSAFE_KEYS.has(key)) map[key] = value;
  }
  return { value: map, next: i };
}

function collectBlockScalar(
  lines: Line[],
  start: number,
  parentIndent: number,
  indicator: string,
): { value: string; next: number } {
  const block: string[] = [];
  let i = start;
  while (i < lines.length && (lines[i] as Line).indent > parentIndent) {
    block.push((lines[i] as Line).text);
    i++;
  }
  const value = indicator.startsWith("|") ? block.join("\n") : block.join(" ");
  return { value: value.trim(), next: i };
}

function unquoteKey(raw: string): string {
  const key = raw.trim();
  if (key.startsWith('"')) {
    try {
      const parsed = JSON.parse(key) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      // fall through to the plain form
    }
  }
  if (key.startsWith("'") && key.endsWith("'") && key.length >= 2) return key.slice(1, -1).replace(/''/g, "'");
  return key;
}

/** The historical top-level scalar rule, kept byte-for-byte. */
function legacyScalar(raw: string): string {
  if (raw.startsWith('"')) {
    // Double-quoted values are emitted via JSON.stringify by renderAgentMarkdown,
    // so parse them the same way — a bare quote-strip would leave \" and \\
    // escapes intact and corrupt any value containing a quote or backslash.
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === "string" ? parsed : raw.replace(/^["']|["']$/g, "");
    } catch {
      return raw.replace(/^["']|["']$/g, "");
    }
  }
  return raw.replace(/^["']|["']$/g, "");
}

function parseScalar(raw: string, depth: number): FrontmatterValue {
  const text = raw.trim();
  if (text.startsWith("[")) {
    const list = parseFlowSequence(text, depth + 1);
    if (list !== undefined) return list;
  }
  if (text.startsWith("{")) {
    const map = parseFlowMap(text, depth + 1);
    if (map !== undefined) return map;
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return legacyScalar(text);
}

function parseFlowSequence(raw: string, depth: number): FrontmatterValue[] | undefined {
  if (depth > MAX_DEPTH || !raw.startsWith("[") || !raw.endsWith("]")) return undefined;
  const parts = splitFlow(raw.slice(1, -1));
  if (parts === undefined) return undefined;
  return parts.filter((part) => part !== "").map((part) => parseScalar(part, depth));
}

function parseFlowMap(raw: string, depth: number): FrontmatterMap | undefined {
  if (depth > MAX_DEPTH || !raw.startsWith("{") || !raw.endsWith("}")) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const converted = fromJson(parsed, depth);
    if (converted !== undefined && typeof converted === "object" && !Array.isArray(converted)) return converted;
  } catch {
    // Not JSON — try the plain YAML flow form below.
  }
  const parts = splitFlow(raw.slice(1, -1));
  if (parts === undefined) return undefined;
  const map: FrontmatterMap = {};
  for (const part of parts) {
    if (part === "") continue;
    const kv = NESTED_KEY_RE.exec(part);
    if (!kv) return undefined;
    const key = unquoteKey(kv[1] as string);
    if (!UNSAFE_KEYS.has(key)) map[key] = parseScalar(kv[2] as string, depth);
  }
  return map;
}

function fromJson(value: unknown, depth: number): FrontmatterValue | undefined {
  if (depth > MAX_DEPTH) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "";
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const converted = fromJson(item, depth + 1);
      return converted === undefined ? [] : [converted];
    });
  }
  if (typeof value === "object") {
    const map: FrontmatterMap = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const converted = fromJson(item, depth + 1);
      if (converted !== undefined && !UNSAFE_KEYS.has(key)) map[key] = converted;
    }
    return map;
  }
  return undefined;
}

/** Splits a flow collection's inside on top-level commas; undefined when brackets or quotes do not balance. */
function splitFlow(inner: string): string[] | undefined {
  const parts: string[] = [];
  let current = "";
  let nesting = 0;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] as string;
    if (quote) {
      current += ch;
      if (quote === '"' && ch === "\\" && i + 1 < inner.length) {
        current += inner[++i];
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "[" || ch === "{") {
      nesting++;
    } else if (ch === "]" || ch === "}") {
      nesting--;
      if (nesting < 0) return undefined;
    } else if (ch === "," && nesting === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote || nesting !== 0) return undefined;
  parts.push(current.trim());
  return parts;
}

export const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function kebabize(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}
