import { useMemo } from "react";
import { parseMarkdown, type MdInline } from "../lib/markdown";

function Inlines({ inlines }: { inlines: MdInline[] }) {
  return (
    <>
      {inlines.map((seg, i) =>
        seg.code ? (
          <code
            key={i}
            className="rounded bg-surface-overlay px-1 py-0.5 font-mono text-[0.85em] text-accent-hover"
          >
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
  1: "text-lg font-bold mt-5",
  2: "text-base font-semibold mt-4",
  3: "text-sm font-semibold mt-3",
};

/** Renders the tiny markdown subset (headers / lists / code / paragraphs). */
export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="space-y-2 leading-relaxed text-primary/90">
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "heading":
            return (
              <div key={i} className={`${HEADING_CLASS[Math.min(block.level, 3)]} text-primary first:mt-0`}>
                <Inlines inlines={block.inlines} />
              </div>
            );
          case "code":
            return (
              <pre
                key={i}
                className="overflow-x-auto rounded-lg border border-subtle bg-surface-raised p-3 font-mono text-xs leading-5 text-secondary"
              >
                <code>{block.code}</code>
              </pre>
            );
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag
                key={i}
                className={`ml-5 space-y-1 marker:text-tertiary ${block.ordered ? "list-decimal" : "list-disc"}`}
              >
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
