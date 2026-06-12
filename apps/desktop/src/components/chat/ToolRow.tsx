import { useState } from "react";
import type { ChatItem } from "../../lib/events";
import { extractDiff } from "../../lib/diff";
import { DiffBlock } from "../DiffBlock";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

function StatusIcon({ status }: { status: ToolItem["status"] }) {
  if (status === "running") return <span className="animate-pulse text-amber-400">●</span>;
  if (status === "ok") return <span className="text-emerald-400">✓</span>;
  return <span className="text-red-400">✗</span>;
}

function Json({ value }: { value: unknown }) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return (
    <pre className="max-h-60 overflow-auto rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-xs text-zinc-400">
      {text}
    </pre>
  );
}

/** Tool call row: name + status, expandable raw args / result JSON. */
export function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const diff = item.result?.ok ? extractDiff(item.result.data) : null;

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs hover:bg-zinc-800/50"
      >
        <StatusIcon status={item.status} />
        <span className="text-zinc-200">{item.name}</span>
        {item.status === "error" && item.result?.error && (
          <span className="truncate text-red-400/80">{item.result.error.message}</span>
        )}
        <span className="ml-auto text-zinc-600">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-zinc-800 px-3 py-2">
          {item.args !== undefined && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">args</div>
              <Json value={item.args} />
            </div>
          )}
          {item.result !== undefined && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">result</div>
              {diff ? <DiffBlock diff={diff} /> : <Json value={item.result} />}
            </div>
          )}
        </div>
      )}
      {/* Live output tail while the command is still running */}
      {item.status === "running" && item.tail !== undefined && (
        <pre className="overflow-x-auto border-t border-zinc-800 px-3 py-1.5 font-mono text-[11px] leading-snug text-zinc-500">
          {item.tail.replace(/\n+$/, "")}
        </pre>
      )}
      {/* Diffs are important enough to show even when collapsed */}
      {!open && diff && (
        <div className="border-t border-zinc-800 px-3 py-2">
          <DiffBlock diff={diff} />
        </div>
      )}
    </div>
  );
}
