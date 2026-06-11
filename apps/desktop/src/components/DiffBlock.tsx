import { useMemo } from "react";
import { splitDiff, type DiffLineKind } from "../lib/diff";

const LINE_CLASS: Record<DiffLineKind, string> = {
  add: "text-emerald-400 bg-emerald-950/40",
  del: "text-red-400 bg-red-950/40",
  hunk: "text-zinc-500",
  meta: "text-zinc-500 font-semibold",
  ctx: "text-zinc-300",
};

/** Unified diff with +/-/@@ coloring in a scrollable monospace block. */
export function DiffBlock({ diff }: { diff: string }) {
  const lines = useMemo(() => splitDiff(diff), [diff]);
  return (
    <pre className="max-h-72 overflow-auto rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-xs leading-5">
      {lines.map((line, i) => (
        <div key={i} className={`whitespace-pre px-1 ${LINE_CLASS[line.kind]}`}>
          {line.text === "" ? " " : line.text}
        </div>
      ))}
    </pre>
  );
}
