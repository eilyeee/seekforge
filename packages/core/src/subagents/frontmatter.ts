/**
 * Minimal YAML-frontmatter reader shared by the agent loader and importer
 * (same subset as skills/import.ts): `key: value`, quoted values, and
 * `key: |` block scalars. Lists and nested maps are ignored.
 */

export type ParsedFrontmatter = {
  fields: Map<string, string>;
  /** Markdown body without the frontmatter block. */
  body: string;
};

export function parseFrontmatter(markdown: string): ParsedFrontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown);
  if (!m) {
    throw new Error("missing YAML frontmatter (--- ... ---)");
  }
  const [, fm, body] = m as unknown as [string, string, string];

  const fields = new Map<string, string>();
  const lines = fm.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = (kv[1] as string).toLowerCase();
    let value = (kv[2] as string).trim();
    if (/^[|>][+-]?$/.test(value)) {
      // Block scalar (incl. chomping indicators |-, |+, >-, >+): consume the
      // indented lines that follow.
      const block: string[] = [];
      while (
        i + 1 < lines.length &&
        (/^\s+\S/.test(lines[i + 1] as string) || (lines[i + 1] as string).trim() === "")
      ) {
        i++;
        block.push((lines[i] as string).trim());
      }
      value = block.join(" ").trim();
    } else if (value.startsWith('"')) {
      // Double-quoted values are emitted via JSON.stringify by renderAgentMarkdown,
      // so parse them the same way — a bare quote-strip would leave \" and \\
      // escapes intact and corrupt any value containing a quote or backslash.
      try {
        const parsed = JSON.parse(value) as unknown;
        value = typeof parsed === "string" ? parsed : value.replace(/^["']|["']$/g, "");
      } catch {
        value = value.replace(/^["']|["']$/g, "");
      }
    } else {
      value = value.replace(/^["']|["']$/g, "");
    }
    fields.set(key, value);
  }

  return { fields, body: body.trim() };
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
