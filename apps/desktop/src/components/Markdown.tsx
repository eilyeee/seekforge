import { useMemo } from "react";
import { parseMarkdown, type MdInline } from "../lib/markdown";

function Inlines({ inlines }: { inlines: MdInline[] }) {
  return (
    <>
      {inlines.map((seg, i) =>
        seg.code ? (
          <code key={i} className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[0.85em] text-emerald-300">
            {seg.text}
          </code>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

const HEADING_CLASS: Record<number, string> = {
  1: "text-lg font-bold",
  2: "text-base font-bold",
  3: "text-sm font-semibold",
};

/** Renders the tiny markdown subset (headers / lists / code / paragraphs). */
export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="space-y-2 leading-relaxed">
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "heading":
            return (
              <div key={i} className={`${HEADING_CLASS[Math.min(block.level, 3)]} mt-3 text-zinc-100 first:mt-0`}>
                <Inlines inlines={block.inlines} />
              </div>
            );
          case "code":
            return (
              <pre
                key={i}
                className="overflow-x-auto rounded border border-zinc-800 bg-zinc-900 p-3 font-mono text-xs text-zinc-300"
              >
                <code>{block.code}</code>
              </pre>
            );
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag key={i} className={`ml-5 space-y-0.5 ${block.ordered ? "list-decimal" : "list-disc"}`}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Inlines inlines={item} />
                  </li>
                ))}
              </Tag>
            );
          }
          case "para":
            return (
              <p key={i}>
                <Inlines inlines={block.inlines} />
              </p>
            );
        }
      })}
    </div>
  );
}
