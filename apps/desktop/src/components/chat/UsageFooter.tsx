import type { TokenUsage } from "@seekforge/shared";
import type { ConnState } from "../../lib/ws";
import type { ContextUsage } from "../../lib/events";
import { formatTokens, formatUsd } from "../../lib/usage";

const CONN_DOT: Record<ConnState, string> = {
  connected: "bg-ok",
  connecting: "bg-warn animate-pulse",
  disconnected: "bg-danger",
};

/** Occupancy color: calm by default, amber from 70%, red from 90%. */
function ctxColor(percent: number): string {
  if (percent >= 90) return "text-danger";
  if (percent >= 70) return "text-warn";
  return "text-tertiary";
}

/** Footer: cumulative token usage + context occupancy + WS connection state. */
export function UsageFooter({
  usage,
  context,
  conn,
}: {
  usage: TokenUsage;
  context?: ContextUsage | null;
  conn: ConnState;
}) {
  return (
    <div className="flex items-center gap-4 border-t border-subtle bg-surface-raised/40 px-4 py-1.5 font-mono text-[11px] text-tertiary">
      <span title="prompt tokens">prompt {formatTokens(usage.promptTokens)}</span>
      <span title="DeepSeek context-cache hits">cache-hit {formatTokens(usage.cacheHitTokens)}</span>
      <span title="completion tokens">completion {formatTokens(usage.completionTokens)}</span>
      <span className="text-secondary" title="cumulative cost">
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
      <span className="ml-auto flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${CONN_DOT[conn]}`} />
        {conn}
      </span>
    </div>
  );
}
