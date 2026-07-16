import type { TokenUsage } from "@seekforge/shared";
import { useT } from "../../lib/i18n";
import type { ConnState } from "../../lib/ws";
import type { ContextUsage } from "../../lib/events";
import { formatTokens, formatUsd } from "../../lib/usage";
import type { AccountBalance } from "../../types";

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
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-subtle bg-surface-raised/40 px-4 py-1.5 font-mono text-2xs text-tertiary">
      <span title={t("chat.usage.promptTitle")}>
        {t("chat.usage.prompt", { tokens: formatTokens(usage.promptTokens) })}
      </span>
      <span title={t("chat.usage.cacheHitTitle")}>
        {t("chat.usage.cacheHit", { tokens: formatTokens(usage.cacheHitTokens) })}
      </span>
      <span title={t("chat.usage.completionTitle")}>
        {t("chat.usage.completion", { tokens: formatTokens(usage.completionTokens) })}
      </span>
      <span className="text-secondary" title={t("chat.usage.costTitle")}>
        {formatUsd(usage.costUsd)}
      </span>
      {context && (
        <span
          className={ctxColor(context.percent)}
          title={t("chat.usage.ctxTitle", {
            used: formatTokens(context.usedTokens),
            budget: formatTokens(context.budgetTokens),
          })}
        >
          {t("chat.usage.ctx", { percent: context.percent })}
        </span>
      )}
      {balance && (
        <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-secondary" title={t("chat.usage.balanceTitle")}>
          {balance.currency === "USD" ? "$" : ""}
          {balance.totalBalance}
          {balance.currency === "USD" ? "" : ` ${balance.currency}`} {t("chat.usage.balanceLeft")}
        </span>
      )}
      <span className="ml-auto flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${CONN_DOT[conn]}`} />
        {t(`status.${conn}`)}
      </span>
    </div>
  );
}
