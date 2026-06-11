import type { TokenUsage } from "@seekforge/shared";
import type { ConnState } from "../../lib/ws";
import { formatTokens, formatUsd } from "../../lib/usage";

const CONN_DOT: Record<ConnState, string> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-500 animate-pulse",
  disconnected: "bg-red-500",
};

/** Footer: cumulative token usage + WS connection state. */
export function UsageFooter({ usage, conn }: { usage: TokenUsage; conn: ConnState }) {
  return (
    <div className="flex items-center gap-4 border-t border-zinc-800 px-4 py-1.5 font-mono text-[11px] text-zinc-500">
      <span title="prompt tokens">prompt {formatTokens(usage.promptTokens)}</span>
      <span title="DeepSeek context-cache hits">cache-hit {formatTokens(usage.cacheHitTokens)}</span>
      <span title="completion tokens">completion {formatTokens(usage.completionTokens)}</span>
      <span className="text-zinc-400" title="cumulative cost">
        {formatUsd(usage.costUsd)}
      </span>
      <span className="ml-auto flex items-center gap-1.5">
        <span className={`h-2 w-2 rounded-full ${CONN_DOT[conn]}`} />
        {conn}
      </span>
    </div>
  );
}
