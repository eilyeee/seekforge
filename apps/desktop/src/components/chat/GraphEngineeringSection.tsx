import { clipLine } from "@seekforge/shared/format";
import { useT } from "../../lib/i18n";
import type {
  EngineeringGraphDetail,
  EngineeringGraphResourceReport,
  EngineeringGraphRunComparison,
  EngineeringGraphSummary,
  EngineeringGraphHealthReport,
} from "../../types";
import { Badge, Button } from "../ui";
import type { BadgeTone } from "../ui/Badge";

function tone(status: string): BadgeTone {
  if (status === "passed") return "ok";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "paused" || status === "waiting_approval") return "warn";
  return "neutral";
}

export function GraphEngineeringSection(props: {
  graphs: EngineeringGraphSummary[];
  details: Record<string, EngineeringGraphDetail>;
  resources: Record<string, EngineeringGraphResourceReport>;
  comparisons: Record<string, EngineeringGraphRunComparison>;
  health: Record<string, EngineeringGraphHealthReport>;
  busy: boolean;
  onInspect: (graphId: string) => void;
  onAction: (graphId: string, operation: "archive" | "prune" | "promote", target?: string) => void;
  onLifecycle: (
    graphId: string,
    operation: "resume" | "approve" | "rerun" | "restart" | "cancel",
    nodeIds?: string[],
  ) => void;
  onControl: (
    graphId: string,
    operation: "pause" | "steer" | "reprioritize" | "cancel",
    nodeId?: string,
    priority?: number,
  ) => void;
  onSignal: (graphId: string, name: string) => void;
  onRecoveryPriority: (graph: EngineeringGraphSummary, delta: number) => void;
  onRemove: (graphId: string) => void;
}) {
  const t = useT();
  if (props.graphs.length === 0) return null;
  return (
    <section className="mt-3 text-xs text-secondary" aria-label={t("chat.loop.graph.title")}>
      <p className="font-medium">{t("chat.loop.graph.title")}</p>
      {props.graphs.map((graph) => {
        const resources = props.resources[graph.graphId];
        const comparison = props.comparisons[graph.graphId];
        const health = props.health[graph.graphId];
        const definition = props.details[graph.graphId]?.definition;
        const nodes =
          definition && typeof definition === "object" && Array.isArray((definition as { nodes?: unknown }).nodes)
            ? ((
                definition as {
                  nodes: Array<{
                    id?: unknown;
                    kind?: unknown;
                    dependsOn?: unknown;
                    priority?: unknown;
                    waitFor?: { signal?: unknown };
                  }>;
                }
              ).nodes ?? [])
            : [];
        return (
          <details key={graph.graphId} className="mt-1 rounded border border-subtle p-2">
            <summary className="cursor-pointer">
              {graph.graphId} · <Badge tone={tone(graph.status)}>{graph.status}</Badge> · {graph.results.length}{" "}
              {t("chat.loop.manager.nodes")} · ${graph.spentCost.toFixed(4)} · {graph.spentTokens.toLocaleString()}{" "}
              {t("chat.loop.graph.tokens")} · {(graph.elapsedMs / 1000).toFixed(1)}s ·{" "}
              {t("chat.loop.manager.priority", { value: graph.priority })}
            </summary>
            <div className="mt-2 flex flex-wrap gap-1">
              {graph.results.map((node) => (
                <Badge key={node.id} tone={tone(node.status)}>
                  {node.id} ({node.kind}): {node.status}
                </Badge>
              ))}
            </div>
            {graph.activeAttempts && graph.activeAttempts.length > 0 && (
              <p className="mt-1 text-tertiary">
                {t("chat.loop.graph.activeAttempts")}:{" "}
                {graph.activeAttempts
                  .map((attempt) => {
                    const retryAt = attempt.nextAttemptAt;
                    return `${attempt.nodeId}#${attempt.attempt}${retryAt ? ` → ${retryAt}` : ""}${
                      attempt.lastError ? ` (${clipLine(attempt.lastError, 160)})` : ""
                    }`;
                  })
                  .join(", ")}
              </p>
            )}
            {graph.recovery && (
              <p className="mt-1 text-tertiary">
                {t("chat.loop.graph.recoveryAttempt", { value: graph.recovery.attempts })}
                {graph.recovery.nextAttemptAt
                  ? ` · ${t("chat.loop.graph.recoveryNext", { value: graph.recovery.nextAttemptAt })}`
                  : ""}
                {graph.recovery.lastError
                  ? ` · ${t("chat.loop.graph.recoveryError", { value: graph.recovery.lastError })}`
                  : ""}
              </p>
            )}
            {nodes.length > 0 && (
              <div className="mt-2 space-y-1 rounded border border-subtle p-2 text-tertiary">
                {nodes.map((node, index) => {
                  const nodeId = typeof node.id === "string" ? node.id : undefined;
                  const result = nodeId ? graph.results.find((candidate) => candidate.id === nodeId) : undefined;
                  const active = nodeId ? graph.activeAttempts?.some((attempt) => attempt.nodeId === nodeId) : false;
                  const waiting = result?.status === "waiting_signal";
                  const controllable = graph.status === "running" && nodeId && !result && !active;
                  return (
                    <div key={nodeId ?? index} className="flex flex-wrap items-center gap-1">
                      <span>
                        {nodeId ?? "?"} ({typeof node.kind === "string" ? node.kind : "?"})
                        {Array.isArray(node.dependsOn) && node.dependsOn.length > 0
                          ? ` ← ${node.dependsOn.filter((id): id is string => typeof id === "string").join(", ")}`
                          : ""}
                      </span>
                      {controllable && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={props.busy}
                            onClick={() => props.onControl(graph.graphId, "pause", nodeId)}
                          >
                            {t("chat.loop.graph.pauseNode")}
                          </Button>
                          {(node.kind === "agent" || node.kind === "loop") && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={props.busy}
                              onClick={() => props.onControl(graph.graphId, "steer", nodeId)}
                            >
                              {t("chat.loop.graph.steer")}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={props.busy}
                            onClick={() =>
                              props.onControl(
                                graph.graphId,
                                "reprioritize",
                                nodeId,
                                typeof node.priority === "number" ? node.priority : 0,
                              )
                            }
                          >
                            {t("chat.loop.graph.priority")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={props.busy}
                            onClick={() => props.onControl(graph.graphId, "cancel", nodeId)}
                          >
                            {t("chat.loop.graph.cancelNode")}
                          </Button>
                        </>
                      )}
                      {waiting && typeof node.waitFor?.signal === "string" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={props.busy}
                          onClick={() => props.onSignal(graph.graphId, node.waitFor!.signal as string)}
                        >
                          {t("chat.loop.graph.signal")}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-2 space-y-1 text-tertiary">
              {graph.events.slice(-8).map((event) => (
                <p key={event.sequence}>
                  #{event.sequence} {event.type}
                  {event.nodeId ? ` · ${event.nodeId}` : ""}
                  {event.message ? ` · ${event.message}` : ""}
                </p>
              ))}
            </div>
            {resources && (
              <p className="mt-1 text-tertiary">
                {(resources.totalBytes / 1024 / 1024).toFixed(2)} MiB · {resources.worktrees.length}{" "}
                {t("chat.loop.manager.worktrees")} ·{" "}
                {resources.archived ? t("chat.loop.manager.archived") : t("chat.loop.manager.retained")}
              </p>
            )}
            {comparison && (
              <div className="mt-1 text-tertiary">
                <p>
                  Δ ${comparison.costDeltaUsd.toFixed(4)} · Δ {comparison.tokenDelta.toLocaleString()}{" "}
                  {t("chat.loop.graph.tokens")}
                  {comparison.durationDeltaMs !== undefined
                    ? ` · Δ ${(comparison.durationDeltaMs / 1000).toFixed(1)}s`
                    : ""}
                </p>
                {comparison.nodes.some(
                  (node) => (node.attemptDelta ?? 0) !== 0 || node.durationDeltaMs !== undefined,
                ) && (
                  <p>
                    {comparison.nodes
                      .filter((node) => (node.attemptDelta ?? 0) !== 0 || node.durationDeltaMs !== undefined)
                      .slice(0, 8)
                      .map(
                        (node) =>
                          `${node.id}: Δ ${node.attemptDelta ?? 0} attempts${
                            node.durationDeltaMs !== undefined
                              ? ` · Δ ${(node.durationDeltaMs / 1000).toFixed(1)}s`
                              : ""
                          }`,
                      )
                      .join("; ")}
                  </p>
                )}
              </div>
            )}
            {health && (
              <div className="mt-1 rounded border border-subtle p-2 text-tertiary">
                <p>
                  {t("chat.loop.health")}:{" "}
                  <Badge
                    tone={tone(
                      health.status === "healthy"
                        ? "passed"
                        : health.status === "critical"
                          ? "failed"
                          : health.status === "warning"
                            ? "paused"
                            : "unknown",
                    )}
                  >
                    {t(`chat.loop.health.status.${health.status}`)}
                  </Badge>
                  {` · ${t("chat.loop.graph.forecast", { value: (health.predictedMakespanMs / 1000).toFixed(1) })}`}
                  {` / P95 ${(health.predictedP95MakespanMs / 1000).toFixed(1)}s`}
                  {` · ${t("chat.loop.graph.coverage", { value: Math.round(health.forecastCoverage.ratio * 100) })}`}
                  {health.criticalPath.length > 0
                    ? ` · ${t("chat.loop.graph.criticalPath", { value: health.criticalPath.join(" → ") })}`
                    : ""}
                </p>
                {health.nodes.some((node) => node.p50DurationMs !== undefined) && (
                  <p>
                    {health.nodes
                      .filter((node) => node.p50DurationMs !== undefined)
                      .slice(0, 8)
                      .map(
                        (node) =>
                          `${node.nodeId}: P50 ${((node.p50DurationMs ?? 0) / 1000).toFixed(1)}s / P95 ${((node.p95DurationMs ?? 0) / 1000).toFixed(1)}s${node.forecastDriftMs !== undefined ? ` / Δ ${(node.forecastDriftMs / 1000).toFixed(1)}s` : ""}`,
                      )
                      .join("; ")}
                  </p>
                )}
                {health.findings.length > 0 && <p>{health.findings.map((finding) => finding.message).join("; ")}</p>}
                {health.risks.length > 0 && <p>{health.risks.join("; ")}</p>}
                {health.recommendations.length > 0 && (
                  <p>
                    {health.recommendations
                      .slice(0, 4)
                      .map(
                        (recommendation) =>
                          `${recommendation.target}: ${recommendation.currentValue} → ${recommendation.suggestedValue} (${t("chat.loop.graph.savings", { value: (recommendation.predictedSavingsMs / 1000).toFixed(1) })})`,
                      )
                      .join("; ")}
                  </p>
                )}
              </div>
            )}
            <div className="mt-1 flex flex-wrap gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={props.busy || graph.priority <= -10}
                onClick={() => props.onRecoveryPriority(graph, -1)}
              >
                −
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={props.busy || graph.priority >= 10}
                onClick={() => props.onRecoveryPriority(graph, 1)}
              >
                +
              </Button>
              <Button size="sm" variant="ghost" disabled={props.busy} onClick={() => props.onInspect(graph.graphId)}>
                {t("chat.loop.manager.inspect")}
              </Button>
              {graph.status === "running" && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={props.busy}
                    onClick={() => props.onControl(graph.graphId, "pause")}
                  >
                    {t("chat.loop.graph.pause")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={props.busy}
                    onClick={() => props.onControl(graph.graphId, "steer")}
                  >
                    {t("chat.loop.graph.steer")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={props.busy}
                    onClick={() => props.onLifecycle(graph.graphId, "cancel")}
                  >
                    {t("chat.loop.graph.cancel")}
                  </Button>
                </>
              )}
              {graph.status === "paused" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={props.busy}
                  onClick={() => {
                    const waiting = graph.results
                      .filter((node) => node.status === "waiting_approval")
                      .map((node) => node.id);
                    props.onLifecycle(graph.graphId, waiting.length > 0 ? "approve" : "resume", waiting);
                  }}
                >
                  {graph.results.some((node) => node.status === "waiting_approval")
                    ? t("chat.loop.graph.approve")
                    : t("chat.loop.graph.resume")}
                </Button>
              )}
              {(graph.status === "failed" || graph.status === "cancelled" || graph.status === "passed") && (
                <>
                  {graph.results.some((node) => node.status === "failed") && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={props.busy}
                      onClick={() =>
                        props.onLifecycle(
                          graph.graphId,
                          "rerun",
                          graph.results.filter((node) => node.status === "failed").map((node) => node.id),
                        )
                      }
                    >
                      {t("chat.loop.graph.rerun")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={props.busy || (resources?.worktrees.length ?? 0) > 0}
                    onClick={() => props.onLifecycle(graph.graphId, "restart")}
                  >
                    {t("chat.loop.graph.restart")}
                  </Button>
                </>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={props.busy || !graph.completedAt}
                onClick={() => props.onAction(graph.graphId, "archive")}
              >
                {t("chat.loop.manager.archive")}
              </Button>
              {graph.fanIn?.status === "passed" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={props.busy}
                  onClick={() => props.onAction(graph.graphId, "promote", "fan-in")}
                >
                  {t("chat.loop.manager.promote")} fan-in
                </Button>
              )}
              {graph.results
                .filter((node) => node.status === "passed" && node.managedBranch)
                .map((node) => (
                  <Button
                    key={`promote-${node.id}`}
                    size="sm"
                    variant="ghost"
                    disabled={props.busy}
                    onClick={() => props.onAction(graph.graphId, "promote", node.id)}
                  >
                    {t("chat.loop.manager.promote")} {node.id}
                  </Button>
                ))}
              <Button
                size="sm"
                variant="ghost"
                disabled={props.busy || !resources?.archived}
                onClick={() => props.onAction(graph.graphId, "prune")}
              >
                {t("chat.loop.manager.pruneResources")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={props.busy || graph.status === "running" || (resources?.worktrees.length ?? 0) > 0}
                onClick={() => props.onRemove(graph.graphId)}
              >
                {t("chat.loop.manager.delete")}
              </Button>
            </div>
          </details>
        );
      })}
    </section>
  );
}
