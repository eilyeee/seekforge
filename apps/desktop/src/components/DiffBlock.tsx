import { useMemo } from "react";
import { diffFilePath, splitDiff, type DiffLineKind } from "../lib/diff";
import { highlightLine, isKnownLang, langFromPath, type TokenClass } from "../lib/highlight";

const LINE_CLASS: Record<DiffLineKind, string> = {
  add: "text-ok bg-ok/10",
  del: "text-danger bg-danger/10",
  hunk: "text-accent/70",
  meta: "text-tertiary font-semibold",
  ctx: "text-secondary",
};

/** Token-class colors for the highlighted content of add/del/ctx lines. */
const TOKEN_CLASS: Record<TokenClass, string> = {
  comment: "text-tertiary italic",
  string: "text-ok",
  number: "text-warn",
  keyword: "text-accent",
  literal: "text-warn",
};

/**
 * Unified diff with +/-/@@ coloring and (when the language is known) per-token
 * syntax highlighting of the line content. Language is inferred from the diff
 * header path or an explicit `lang` prop; unknown languages fall back to the
 * plain colored lines. The +/-/space prefix and add/del tint are preserved.
 */
export function DiffBlock({ diff, lang }: { diff: string; lang?: string }) {
  const lines = useMemo(() => splitDiff(diff), [diff]);
  const resolvedLang = useMemo(
    () => lang ?? langFromPath(diffFilePath(diff)),
    [diff, lang],
  );
  const highlight = isKnownLang(resolvedLang);

  return (
    <pre className="max-h-72 overflow-auto rounded-lg border border-subtle bg-surface py-1.5 font-mono text-xs leading-5">
      {lines.map((line, i) => {
        const tinted = line.kind === "add" || line.kind === "del" || line.kind === "ctx";
        // Only tokenize actual code lines; meta/hunk lines stay plain.
        if (highlight && tinted) {
          const prefix = line.text.slice(0, 1);
          const content = line.text.slice(1);
          const { tokens } = highlightLine(content, resolvedLang);
          return (
            <div key={i} className={`whitespace-pre px-3 ${LINE_CLASS[line.kind]}`}>
              {line.text === "" ? (
                " "
              ) : (
                <>
                  <span>{prefix}</span>
                  {tokens.map((t, j) => (
                    <span key={j} className={t.cls ? TOKEN_CLASS[t.cls] : undefined}>
                      {t.text}
                    </span>
                  ))}
                </>
              )}
            </div>
          );
        }
        return (
          <div key={i} className={`whitespace-pre px-3 ${LINE_CLASS[line.kind]}`}>
            {line.text === "" ? " " : line.text}
          </div>
        );
      })}
    </pre>
  );
}
