import { useState } from "react";
import type { ChatItem } from "../../lib/events";
import { formatTokens, formatUsd } from "../../lib/usage";
import { Markdown } from "../Markdown";
import { PlanCard } from "./PlanCard";
import { ToolRow } from "./ToolRow";

/**
 * Streamed chain-of-thought: a dim block, expanded while streaming and
 * collapsed to one line once the answer starts (click toggles).
 */
function ThinkingBlock({ item }: { item: Extract<ChatItem, { kind: "thinking" }> }) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? item.streaming;
  return (
    <div className="rounded border border-zinc-800/80 bg-zinc-900/40">
      <button
        type="button"
        onClick={() => setManualOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs text-zinc-500 hover:text-zinc-400"
      >
        <span className={item.streaming ? "animate-pulse" : ""}>✻</span>
        <span className="italic">thinking{item.streaming ? "…" : ""}</span>
        <span className="ml-auto text-zinc-700">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="whitespace-pre-wrap border-t border-zinc-800/80 px-3 py-2 text-xs italic text-zinc-500">
          {item.text}
        </div>
      )}
    </div>
  );
}

function ItemView({ item, onBacktrack }: { item: ChatItem; onBacktrack?: (itemId: number) => void }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="group flex items-start justify-end gap-1.5">
          {onBacktrack && (
            <button
              type="button"
              onClick={() => onBacktrack(item.id)}
              title="Rewind the conversation to just before this message"
              className="mt-1 rounded border border-zinc-700 px-1.5 py-0.5 text-xs text-zinc-500 opacity-0 hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100"
            >
              ↺
            </button>
          )}
          <div className="max-w-[85%] whitespace-pre-wrap rounded-lg border border-emerald-900/60 bg-emerald-950/40 px-3 py-2 text-zinc-100">
            {item.text}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="max-w-[95%]">
          <Markdown source={item.text} />
          {item.streaming && <span className="ml-0.5 animate-pulse text-emerald-400">▌</span>}
        </div>
      );
    case "thinking":
      return <ThinkingBlock item={item} />;
    case "tool":
      return <ToolRow item={item} />;
    case "plan":
      return <PlanCard items={item.items} />;
    case "substep":
      return (
        <div className="rounded border border-violet-900/60 bg-violet-950/20 px-3 py-1.5 text-xs">
          <span className="font-mono font-semibold text-violet-300">⤷ {item.agentId}</span>
          <span className="ml-2 font-mono text-zinc-500">{item.steps.join(" · ")}</span>
        </div>
      );
    case "file":
      return (
        <div className="inline-flex items-center gap-1.5 rounded-full border border-sky-900 bg-sky-950/40 px-2.5 py-0.5 font-mono text-xs text-sky-300">
          <span>±</span>
          <span>{item.path}</span>
        </div>
      );
    case "compacted":
      return (
        <div className="rounded border border-dashed border-zinc-700 px-3 py-1.5 text-center text-xs text-zinc-500">
          context compacted — {item.droppedTurns} turns summarized into ~{item.summaryTokens} tokens
        </div>
      );
    case "microcompacted":
      return (
        <div className="rounded border border-dashed border-zinc-800 px-3 py-1 text-center text-xs text-zinc-600">
          context micro-compacted — {item.clearedResults} old tool result(s) cleared
        </div>
      );
    case "report":
      return (
        <div className="rounded border border-emerald-900/60 bg-emerald-950/20 px-3 py-2 text-xs text-zinc-400">
          <span className="font-semibold text-emerald-400">session completed</span>
          {item.report.changedFiles.length > 0 && (
            <span> · {item.report.changedFiles.length} file(s) changed</span>
          )}
          <span>
            {" "}
            · {formatTokens(item.report.usage.promptTokens + item.report.usage.completionTokens)} tokens ·{" "}
            {formatUsd(item.report.usage.costUsd)}
          </span>
          <div className="mt-1 font-mono text-zinc-500">{item.report.verification}</div>
        </div>
      );
    case "failed": {
      // Genuine, recoverable failures (not user cancels) get the exact resume
      // command; the loop sets recoverable + sessionId on the error.
      const resumeId = item.error.recoverable ? item.error.sessionId : undefined;
      return (
        <div className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm">
          <span className="font-mono text-xs text-red-400">[{item.error.code}]</span>{" "}
          <span className="text-red-200">{item.error.message}</span>
          {item.error.hint && <div className="mt-1 text-xs text-red-300/80">→ {item.error.hint}</div>}
          {resumeId && (
            <div className="mt-1 text-xs text-red-300/80">
              → resume with <span className="font-mono text-red-200">/resume {resumeId}</span> (your file
              changes and completed steps are preserved; checkpoints intact)
            </div>
          )}
        </div>
      );
    }
  }
}

/**
 * Shared renderer for live chat and read-only session transcripts.
 * `onBacktrack` (live chat only) puts a ↺ rewind button on every user bubble
 * except the first — turn 0 is the original task and is not backtrackable.
 */
export function ChatItems({
  items,
  onBacktrack,
}: {
  items: ChatItem[];
  onBacktrack?: (itemId: number) => void;
}) {
  const firstUserId = items.find((i) => i.kind === "user")?.id;
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <ItemView
          key={item.id}
          item={item}
          onBacktrack={item.kind === "user" && item.id !== firstUserId ? onBacktrack : undefined}
        />
      ))}
    </div>
  );
}
