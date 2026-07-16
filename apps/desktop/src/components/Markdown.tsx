import { useMemo } from "react";
import { parseMarkdown, type MdBlock, type MdInline } from "../lib/markdown";
import { highlightLines, isKnownLang, type TokenClass } from "../lib/highlight";
import { useStore } from "../store";

/** Extensions that make a bare (slash-less) `code` span look like a file ref. */
const FILE_EXTS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "cc",
  "cpp",
  "cxx",
  "h",
  "hpp",
  "cs",
  "rb",
  "php",
  "swift",
  "md",
  "markdown",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "ini",
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "xml",
  "svg",
  "sh",
  "bash",
  "sql",
  "txt",
  "lock",
  "vue",
  "svelte",
]);

/**
 * Recognizes a workspace file reference inside a `code` span: `path.ext`,
 * `path.ext:line`, optional leading `@` or `./`. Conservative — a slash-less
 * token must carry a known file extension so `a.length` / `obj.method` don't
 * become links. Returns null for non-paths.
 */
export function parseFileRef(text: string): { path: string; line?: number } | null {
  const s = text.trim();
  if (s === "" || /\s/.test(s) || s.includes("://")) return null;
  const m = /^@?([A-Za-z0-9._/@~+-]+\.[A-Za-z0-9]+)(?::(\d+))?(?::\d+)?$/.exec(s);
  if (!m) return null;
  const path = (m[1] as string).replace(/^\.\//, "");
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  if (!path.includes("/") && !FILE_EXTS.has(ext)) return null;
  return { path, ...(m[2] ? { line: Number(m[2]) } : {}) };
}

/** Maps a highlighter token class to a semantic-token text color. */
const TOKEN_CLASS: Record<TokenClass, string> = {
  comment: "text-tertiary italic",
  string: "text-ok",
  number: "text-warn",
  keyword: "text-accent",
  literal: "text-warn",
};

function Inlines({ inlines }: { inlines: MdInline[] }) {
  return (
    <>
      {inlines.map((seg, i) => {
        switch (seg.kind) {
          case "text":
            return <span key={i}>{seg.text}</span>;
          case "code": {
            const ref = parseFileRef(seg.text);
            if (ref) {
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() =>
                    useStore.getState().openFileAt(ref.path, ref.line !== undefined ? { line: ref.line } : undefined)
                  }
                  title={seg.text}
                  className="rounded bg-surface-overlay px-1 py-0.5 font-mono text-[0.85em] text-accent-hover underline-offset-2 hover:underline"
                >
                  {seg.text}
                </button>
              );
            }
            return (
              <code
                key={i}
                className="rounded bg-surface-overlay px-1 py-0.5 font-mono text-[0.85em] text-accent-hover"
              >
                {seg.text}
              </code>
            );
          }
          case "strong":
            return (
              <strong key={i} className="font-semibold text-primary">
                <Inlines inlines={seg.children} />
              </strong>
            );
          case "em":
            return (
              <em key={i} className="italic">
                <Inlines inlines={seg.children} />
              </em>
            );
          case "link":
            return (
              <a
                key={i}
                href={seg.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline decoration-accent/40 underline-offset-2 hover:text-accent-hover"
              >
                <Inlines inlines={seg.children} />
              </a>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

const HEADING_CLASS: Record<number, string> = {
  1: "text-lg font-bold mt-5",
  2: "text-base font-semibold mt-4",
  3: "text-sm font-semibold mt-3",
};

/** A fenced code block with dependency-free per-language token coloring. */
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const lines = useMemo(() => highlightLines(code, lang), [code, lang]);
  const known = isKnownLang(lang);
  return (
    <pre className="overflow-x-auto rounded-lg border border-subtle bg-surface-raised p-3 font-mono text-xs leading-5 text-secondary">
      <code>
        {known
          ? lines.map((tokens, i) => (
              <div key={i}>
                {tokens.length === 0
                  ? "\n"
                  : tokens.map((t, j) => (
                      <span key={j} className={t.cls ? TOKEN_CLASS[t.cls] : undefined}>
                        {t.text}
                      </span>
                    ))}
              </div>
            ))
          : code}
      </code>
    </pre>
  );
}

function Block({ block }: { block: MdBlock }) {
  switch (block.kind) {
    case "heading":
      return (
        <div className={`${HEADING_CLASS[Math.min(block.level, 3)]} text-primary first:mt-0`}>
          <Inlines inlines={block.inlines} />
        </div>
      );
    case "code":
      return <CodeBlock lang={block.lang} code={block.code} />;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag className={`ml-5 space-y-1 marker:text-tertiary ${block.ordered ? "list-decimal" : "list-disc"}`}>
          {block.items.map((item, j) => (
            <li key={j}>
              <Inlines inlines={item.inlines} />
              {item.children && item.children.length > 0 && (
                <div className="mt-1">
                  {item.children.map((child, k) => (
                    <Block key={k} block={child} />
                  ))}
                </div>
              )}
            </li>
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {block.header.map((cell, j) => (
                  <th
                    key={j}
                    className="border border-subtle bg-surface-raised px-2 py-1 text-left font-semibold text-primary"
                  >
                    <Inlines inlines={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className="border border-subtle px-2 py-1 align-top">
                      <Inlines inlines={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "blockquote":
      return (
        <blockquote className="border-l-2 border-subtle pl-3 text-secondary">
          <div className="space-y-2">
            {block.children.map((child, k) => (
              <Block key={k} block={child} />
            ))}
          </div>
        </blockquote>
      );
    case "hr":
      return <hr className="border-subtle" />;
    case "para":
      return (
        <p>
          <Inlines inlines={block.inlines} />
        </p>
      );
  }
}

/** Renders the GFM-ish markdown subset (headings / lists / code / tables / … ). */
export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="space-y-2 break-words leading-relaxed text-primary/90">
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}
