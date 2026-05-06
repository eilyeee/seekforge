import type { TokenUsage } from "@seekforge/shared";
import type { ConnState } from "../../lib/ws";
import type { ContextUsage } from "../../lib/events";
import { formatTokens, formatUsd } from "../../lib/usage";
import type { AccountBalance } from "../../types";

const CONN_DOT: Record<ConnState, string> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-500 animate-pulse",
  disconnected: "bg-red-500",
};

/** Occupancy color: calm by default, amber from 70%, red from 90%. */
function ctxColor(percent: number): string {
  if (percent >= 90) return "text-red-400";
  if (percent >= 70) return "text-amber-400";
  return "text-zinc-500";
}

/** Footer: token usage + context occupancy + account balance + WS state. */
export function UsageFooter({
  usage,
  context,
  conn,
  balance,
}: {
  usage: TokenUsage;
  context?: ContextUsage | null;
  conn: ConnState;
  /** DeepSeek account balance; null/undefined = unknown (chip hidden). */
  balance?: AccountBalance | null;
}) {
  return (
    <div className="flex items-center gap-4 border-t border-zinc-800 px-4 py-1.5 font-mono text-[11px] text-zinc-500">
      <span title="prompt tokens">prompt {formatTokens(usage.promptTokens)}</span>
      <span title="DeepSeek context-cache hits">cache-hit {formatTokens(usage.cacheHitTokens)}</span>
      <span title="completion tokens">completion {formatTokens(usage.completionTokens)}</span>
      <span className="text-zinc-400" title="cumulative cost">
        {formatUsd(usage.costUsd)}
      </span>
      {context && (
        <span
          className={ctxColor(context.percent)}
          title={`context window: ${formatTokens(context.usedTokens)} of ${formatTokens(context.budgetTokens)} budget tokens used`}
        >
          ctx {context.percent}%
        </span>
      )}
      {balance && (
        <span
          className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-zinc-400"
          title="DeepSeek account balance remaining"
        >
          {balance.currency === "USD" ? "$" : ""}
          {balance.totalBalance}
          {balance.currency === "USD" ? "" : ` ${balance.currency}`} left
        </span>
      )}
      <span className="ml-auto flex items-center gap-1.5">
        <span className={`h-2 w-2 rounded-full ${CONN_DOT[conn]}`} />
        {conn}
      </span>
    </div>
  );
}
