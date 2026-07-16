/**
 * Small GFM-ish markdown parser — headings, lists (nested), fenced code,
 * tables, blockquotes, horizontal rules, paragraphs, and inline spans (code,
 * bold, italic, bold-italic, links, autolinks). No dependency, no HTML
 * passthrough (output is structured data rendered via React, so it is XSS-safe
 * by construction). Streaming-tolerant: half-written tables/links/fences render
 * gracefully rather than crashing.
 */

export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: MdInline[] }
  | { kind: "em"; children: MdInline[] }
  | { kind: "link"; href: string; children: MdInline[] };

export type MdListItem = { inlines: MdInline[]; children?: MdBlock[] };

export type MdBlock =
  | { kind: "heading"; level: number; inlines: MdInline[] }
  | { kind: "code"; lang: string; code: string }
  | { kind: "list"; ordered: boolean; items: MdListItem[] }
  | { kind: "table"; header: MdInline[][]; rows: MdInline[][][] }
  | { kind: "blockquote"; children: MdBlock[] }
  | { kind: "hr" }
  | { kind: "para"; inlines: MdInline[] };

// ---------------------------------------------------------------------------
// Inline parsing.

const URL_RE = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/;

/** Parses inline markup into a tree of text/code/strong/em/link nodes. */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  const pushText = (t: string) => {
    if (t === "") return;
    const last = out[out.length - 1];
    if (last && last.kind === "text") last.text += t;
    else out.push({ kind: "text", text: t });
  };

  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] as string;

    // Inline code: `...` (a lone trailing backtick stays literal).
    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      if (close === -1) {
        pushText(text.slice(i));
        break;
      }
      out.push({ kind: "code", text: text.slice(i + 1, close) });
      i = close + 1;
      continue;
    }

    // Link: [text](url). Falls back to literal "[" on a malformed/partial link.
    if (ch === "[") {
      const link = matchLink(text, i);
      if (link) {
        out.push({ kind: "link", href: link.href, children: parseInline(link.label) });
        i = link.end;
        continue;
      }
    }

    // Bold-italic / bold / italic via * or _ runs.
    if (ch === "*" || ch === "_") {
      const emph = matchEmphasis(text, i, ch);
      if (emph) {
        const inner = parseInline(emph.inner);
        out.push(
          emph.strong && emph.em
            ? { kind: "strong", children: [{ kind: "em", children: inner }] }
            : emph.strong
              ? { kind: "strong", children: inner }
              : { kind: "em", children: inner },
        );
        i = emph.end;
        continue;
      }
    }

    // Bare http(s) autolink.
    if (ch === "h" && (text.startsWith("http://", i) || text.startsWith("https://", i))) {
      const m = URL_RE.exec(text.slice(i));
      if (m && m.index === 0) {
        out.push({ kind: "link", href: m[0], children: [{ kind: "text", text: m[0] }] });
        i += m[0].length;
        continue;
      }
    }

    pushText(ch);
    i++;
  }
  return out;
}

/** Matches a [label](href) starting at `start` (which must be "["). */
function matchLink(text: string, start: number): { label: string; href: string; end: number } | null {
  // Find the matching close bracket (tolerate nested brackets one level).
  let depth = 0;
  let close = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1 || text[close + 1] !== "(") return null;
  const parenClose = text.indexOf(")", close + 2);
  if (parenClose === -1) return null;
  const label = text.slice(start + 1, close);
  const href = text.slice(close + 2, parenClose).trim();
  if (href === "") return null;
  return { label, href, end: parenClose + 1 };
}

/** Matches an emphasis run (1=italic, 2=bold, 3=bold-italic) at `start`. */
function matchEmphasis(
  text: string,
  start: number,
  marker: string,
): { strong: boolean; em: boolean; inner: string; end: number } | null {
  // Count the opening run length (1=em, 2=strong, 3=both).
  let run = 0;
  while (text[start + run] === marker && run < 3) run++;
  if (run === 0) return null;
  const open = marker.repeat(run);
  // Closing run of the same marker; the char right after the open must not be
  // whitespace (so "* foo" / "a * b" stay literal).
  if (/\s/.test(text[start + run] ?? "")) return null;
  const close = text.indexOf(open, start + run);
  if (close === -1) return null;
  const inner = text.slice(start + run, close);
  if (inner === "") return null;
  return {
    strong: run >= 2,
    em: run === 1 || run === 3,
    inner,
    end: close + run,
  };
}

// ---------------------------------------------------------------------------
// Block parsing.

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)\d+[.)]\s+(.*)$/;
const FENCE_RE = /^```(.*)$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BLOCKQUOTE_RE = /^\s*>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim() !== "";
}

/** Splits a "| a | b |" row into cell strings (drops the optional edge pipes). */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // Split on unescaped pipes.
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur.trim());
  return cells;
}

export function parseMarkdown(src: string): MdBlock[] {
  return parseBlocks(src.split("\n"));
}

function parseBlocks(lines: string[]): MdBlock[] {
  const blocks: MdBlock[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ kind: "para", inlines: parseInline(para.join(" ")) });
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // Fenced code.
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushPara();
      const lang = (fence[1] ?? "").trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "");
        i++;
      }
      blocks.push({ kind: "code", lang, code: code.join("\n") });
      continue;
    }

    // Horizontal rule (checked before headings/lists; "---" alone is an hr).
    if (HR_RE.test(line)) {
      flushPara();
      blocks.push({ kind: "hr" });
      continue;
    }

    // Heading.
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushPara();
      blocks.push({
        kind: "heading",
        level: (heading[1] ?? "#").length,
        inlines: parseInline(heading[2] ?? ""),
      });
      continue;
    }

    // Blockquote: gather consecutive "> " lines, recurse on the stripped body.
    if (BLOCKQUOTE_RE.test(line)) {
      flushPara();
      const inner: string[] = [];
      while (i < lines.length && BLOCKQUOTE_RE.test(lines[i] ?? "")) {
        inner.push(BLOCKQUOTE_RE.exec(lines[i] ?? "")?.[1] ?? "");
        i++;
      }
      i--;
      blocks.push({ kind: "blockquote", children: parseBlocks(inner) });
      continue;
    }

    // Table: a row followed by a |---|---| separator. Malformed → plain text.
    if (isTableRow(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1] ?? "")) {
      flushPara();
      const header = splitTableRow(line).map(parseInline);
      const cols = header.length;
      i += 2; // skip header + separator
      const rows: MdInline[][][] = [];
      while (i < lines.length && isTableRow(lines[i] ?? "") && !TABLE_SEP_RE.test(lines[i] ?? "")) {
        const cells = splitTableRow(lines[i] ?? "");
        // Pad/truncate to the header column count for a rectangular table.
        const row: MdInline[][] = [];
        for (let c = 0; c < cols; c++) row.push(parseInline(cells[c] ?? ""));
        rows.push(row);
        i++;
      }
      i--;
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    // Lists (with one level of nesting via indentation).
    const ul = UL_RE.exec(line);
    const ol = ul ? null : OL_RE.exec(line);
    if (ul || ol) {
      const consumed = parseList(lines, i, blocks, flushPara);
      i = consumed;
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      continue;
    }

    para.push(line.trim());
  }
  flushPara();
  return blocks;
}

/**
 * Parses a list starting at `start`; appends a list block and returns the index
 * of the last consumed line. Indented bullets become nested child lists.
 */
function parseList(lines: string[], start: number, blocks: MdBlock[], flushPara: () => void): number {
  flushPara();
  const baseIndent = listIndent(lines[start] ?? "");
  const ordered = OL_RE.test(lines[start] ?? "") && !UL_RE.test(lines[start] ?? "");
  const items: MdListItem[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const m = matchListItem(line);
    if (!m) break;
    if (m.indent < baseIndent) break; // belongs to an outer list

    if (m.indent > baseIndent) {
      // Nested list: parse recursively and attach to the previous item.
      const nested: MdBlock[] = [];
      const consumed = parseList(lines, i, nested, () => {});
      const prev = items[items.length - 1];
      if (prev) prev.children = [...(prev.children ?? []), ...nested];
      else items.push({ inlines: [], children: nested });
      i = consumed + 1;
      continue;
    }

    // Same-level item: ordered/unordered must match to stay in this list.
    if (m.ordered !== ordered) break;
    items.push({ inlines: parseInline(m.content) });
    i++;
  }

  blocks.push({ kind: "list", ordered, items });
  return i - 1;
}

function listIndent(line: string): number {
  const m = UL_RE.exec(line) ?? OL_RE.exec(line);
  return (m?.[1] ?? "").length;
}

function matchListItem(line: string): { indent: number; ordered: boolean; content: string } | null {
  const ul = UL_RE.exec(line);
  if (ul) return { indent: (ul[1] ?? "").length, ordered: false, content: ul[2] ?? "" };
  const ol = OL_RE.exec(line);
  if (ol) return { indent: (ol[1] ?? "").length, ordered: true, content: ol[2] ?? "" };
  return null;
}
