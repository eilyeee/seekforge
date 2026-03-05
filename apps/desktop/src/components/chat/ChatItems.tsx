import type { ChatItem } from "../../lib/events";
import { formatTokens, formatUsd } from "../../lib/usage";
import { Markdown } from "../Markdown";
import { PlanCard } from "./PlanCard";
import { ToolRow } from "./ToolRow";

function ItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end">
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
    case "tool":
      return <ToolRow item={item} />;
    case "plan":
      return <PlanCard items={item.items} />;
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
    case "failed":
      return (
        <div className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm">
          <span className="font-mono text-xs text-red-400">[{item.error.code}]</span>{" "}
          <span className="text-red-200">{item.error.message}</span>
        </div>
      );
  }
}

/** Shared renderer for live chat and read-only session transcripts. */
export function ChatItems({ items }: { items: ChatItem[] }) {
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <ItemView key={item.id} item={item} />
      ))}
    </div>
  );
}
