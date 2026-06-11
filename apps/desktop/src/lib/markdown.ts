/**
 * Tiny markdown parser — headings, lists, fenced code blocks, paragraphs and
 * inline `code` spans only. No dependency, no HTML passthrough (output is
 * structured data rendered via React, so it is XSS-safe by construction).
 */

export type MdInline = { code: boolean; text: string };

export type MdBlock =
  | { kind: "heading"; level: number; inlines: MdInline[] }
  | { kind: "code"; lang: string; code: string }
  | { kind: "list"; ordered: boolean; items: MdInline[][] }
  | { kind: "para"; inlines: MdInline[] };

export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  const push = (code: boolean, t: string) => {
    if (t === "") return;
    const last = out[out.length - 1];
    if (last && last.code === code) last.text += t;
    else out.push({ code, text: t });
  };
  // Segments at odd indices were opened by a backtick; they are code only
  // when a closing backtick follows (i.e. they are not the last segment).
  const parts = text.split("`");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    if (i % 2 === 1 && i === parts.length - 1) push(false, `\`${part}`);
    else push(i % 2 === 1, part);
  }
  return out;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^\s*[-*+]\s+(.*)$/;
const OL_RE = /^\s*\d+[.)]\s+(.*)$/;
const FENCE_RE = /^```(.*)$/;

export function parseMarkdown(src: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = src.split("\n");
  let para: string[] = [];

  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ kind: "para", inlines: parseInline(para.join(" ")) });
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

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

    const ul = UL_RE.exec(line);
    const ol = ul ? null : OL_RE.exec(line);
    if (ul || ol) {
      flushPara();
      const ordered = Boolean(ol);
      const items: MdInline[][] = [parseInline((ul?.[1] ?? ol?.[1]) ?? "")];
      while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? "";
        const m = ordered ? OL_RE.exec(next) : UL_RE.exec(next);
        if (!m) break;
        items.push(parseInline(m[1] ?? ""));
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
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
