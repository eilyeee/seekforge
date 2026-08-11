import { useT } from "../../lib/i18n";
import { loopHistoryDetail } from "../../lib/loop";
import type { LoopEvidenceReport, LoopHealthReport, LoopHistoryEntry } from "../../types";
import { Badge, Button } from "../ui";

export function LoopDetailsSection(props: {
  selected?: string;
  evidence?: LoopEvidenceReport;
  health?: LoopHealthReport;
  history: LoopHistoryEntry[];
  onLoadMore: () => void;
}) {
  const t = useT();
  if (!props.selected) return null;
  return (
    <div className="mt-2 rounded border border-subtle bg-surface p-2 text-xs text-secondary">
      {props.health && (
        <div className="mb-2 rounded border border-subtle p-2 text-tertiary">
          <p>
            {t("chat.loop.health")}:{" "}
            <Badge
              tone={
                props.health.status === "healthy" ? "ok" : props.health.status === "critical" ? "danger" : "neutral"
              }
            >
              {t(`chat.loop.health.status.${props.health.status}`)}
            </Badge>
            {` · ${t("chat.loop.health.affordable", { value: props.health.forecast.affordableIterations })}`}
            {props.health.forecast.limitingBudget
              ? ` · ${t("chat.loop.health.limitedBy", {
                  value: t(`chat.loop.health.budget.${props.health.forecast.limitingBudget}`),
                })}`
              : ""}
          </p>
          <p>
            {t("chat.loop.health.next", {
              cost: props.health.forecast.nextIterationCostUsd.toFixed(4),
              tokens: props.health.forecast.nextIterationTokens,
              duration: props.health.forecast.nextIterationDurationMs,
            })}
          </p>
          {props.health.findings.length > 0 && (
            <p>{props.health.findings.map((finding) => finding.message).join("; ")}</p>
          )}
        </div>
      )}
      {props.evidence && (
        <div className="mb-2 grid gap-2 md:grid-cols-3">
          <section>
            <p className="font-medium text-primary">{t("chat.loop.manager.verification")}</p>
            {props.evidence.verification.map((stage) => (
              <div key={stage.id} className="mt-1 flex items-center gap-1">
                <Badge tone={stage.code === 0 ? "ok" : stage.code === undefined ? "neutral" : "danger"}>
                  {stage.code === undefined ? "pending" : stage.code === 0 ? "pass" : `exit ${stage.code}`}
                </Badge>
                <span className="font-mono">{stage.id}</span>
                <span className="text-tertiary">
                  {stage.selection ?? "full"} · {stage.durationMs ?? 0}ms
                </span>
              </div>
            ))}
          </section>
          <section>
            <p className="font-medium text-primary">{t("chat.loop.manager.criteria")}</p>
            {props.evidence.criteria.length === 0 && <p className="mt-1 text-tertiary">—</p>}
            {props.evidence.criteria.map((criterion) => (
              <div key={criterion.id} className="mt-1">
                <Badge tone={criterion.status === "met" ? "ok" : "neutral"}>{criterion.status}</Badge> {criterion.id} ·{" "}
                {criterion.text}
                {criterion.evidence.length > 0 && (
                  <p className="truncate font-mono text-2xs text-tertiary">{criterion.evidence.join(" · ")}</p>
                )}
              </div>
            ))}
          </section>
          <section>
            <p className="font-medium text-primary">{t("chat.loop.manager.timeline")}</p>
            {props.evidence.iterations.map((iteration) => (
              <div key={`${iteration.iteration}-${iteration.ts}`} className="mt-1">
                #{iteration.iteration} · {iteration.failureCategory ?? "none"} · {iteration.durationMs ?? 0}ms · $
                {(iteration.costUsd ?? 0).toFixed(4)}
                {iteration.rolledBack ? " · rollback" : ""}
              </div>
            ))}
          </section>
        </div>
      )}
      <p className="font-medium text-primary">{t("chat.loop.manager.history")}</p>
      <div className="mt-1 max-h-48 overflow-auto font-mono text-2xs">
        {props.history.length === 0
          ? t("chat.loop.manager.noHistory")
          : props.history.map((entry) => {
              // The type alone reads as five words for an event that carries a
              // message, an exit code or a stage id; the detail is clipped, so
              // the log stays bounded while still saying what happened.
              const detail = loopHistoryDetail(entry.event);
              return (
                <div key={entry.seq} className="truncate">
                  {entry.seq} · {entry.ts} · {entry.event.type}
                  {detail ? ` · ${detail}` : ""}
                </div>
              );
            })}
        {props.history.length > 0 && props.history.length % 100 === 0 && (
          <Button size="sm" variant="ghost" onClick={props.onLoadMore}>
            {t("chat.loop.manager.loadMore")}
          </Button>
        )}
      </div>
    </div>
  );
}
