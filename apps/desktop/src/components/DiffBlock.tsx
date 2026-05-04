import { useMemo } from "react";
import { splitDiff, type DiffLineKind } from "../lib/diff";

const LINE_CLASS: Record<DiffLineKind, string> = {
  add: "text-ok bg-ok/10",
  del: "text-danger bg-danger/10",
  hunk: "text-accent/70",
  meta: "text-tertiary font-semibold",
  ctx: "text-secondary",
};

/** Unified diff with +/-/@@ coloring in a scrollable monospace block. */
export function DiffBlock({ diff }: { diff: string }) {
  const lines = useMemo(() => splitDiff(diff), [diff]);
  return (
    <pre className="max-h-72 overflow-auto rounded-lg border border-subtle bg-surface py-1.5 font-mono text-xs leading-5">
      {lines.map((line, i) => (
        <div key={i} className={`whitespace-pre px-3 ${LINE_CLASS[line.kind]}`}>
          {line.text === "" ? " " : line.text}
        </div>
      ))}
    </pre>
  );
}
