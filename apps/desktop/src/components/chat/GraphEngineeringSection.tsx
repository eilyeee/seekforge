import { useT } from "../../lib/i18n";
import type { EngineeringGraphDetail, EngineeringGraphResourceReport, EngineeringGraphSummary } from "../../types";
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
  busy: boolean;
  onInspect: (graphId: string) => void;
  onAction: (graphId: string, operation: "archive" | "prune" | "promote", target?: string) => void;
  onRemove: (graphId: string) => void;
}) {
  const t = useT();
  if (props.graphs.length === 0) return null;
  return (
    <section className="mt-3 text-xs text-secondary" aria-label={t("chat.loop.graph.title")}>
      <p className="font-medium">{t("chat.loop.graph.title")}</p>
      {props.graphs.map((graph) => {
        const resources = props.resources[graph.graphId];
        const definition = props.details[graph.graphId]?.definition;
        const nodes =
          definition && typeof definition === "object" && Array.isArray((definition as { nodes?: unknown }).nodes)
            ? ((definition as { nodes: Array<{ id?: unknown; kind?: unknown; dependsOn?: unknown }> }).nodes ?? [])
            : [];
        return (
          <details key={graph.graphId} className="mt-1 rounded border border-subtle p-2">
            <summary className="cursor-pointer">
              {graph.graphId} · <Badge tone={tone(graph.status)}>{graph.status}</Badge> · {graph.results.length}{" "}
              {t("chat.loop.manager.nodes")} · ${graph.spentCost.toFixed(4)} · {graph.spentTokens.toLocaleString()}{" "}
              {t("chat.loop.graph.tokens")}
            </summary>
            <div className="mt-2 flex flex-wrap gap-1">
              {graph.results.map((node) => (
                <Badge key={node.id} tone={tone(node.status)}>
                  {node.id} ({node.kind}): {node.status}
                </Badge>
              ))}
            </div>
            {nodes.length > 0 && (
              <div className="mt-2 space-y-1 rounded border border-subtle p-2 text-tertiary">
                {nodes.map((node, index) => (
                  <p key={typeof node.id === "string" ? node.id : index}>
                    {typeof node.id === "string" ? node.id : "?"} ({typeof node.kind === "string" ? node.kind : "?"})
                    {Array.isArray(node.dependsOn) && node.dependsOn.length > 0
                      ? ` ← ${node.dependsOn.filter((id): id is string => typeof id === "string").join(", ")}`
                      : ""}
                  </p>
                ))}
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
            <div className="mt-1 flex flex-wrap gap-1">
              <Button size="sm" variant="ghost" disabled={props.busy} onClick={() => props.onInspect(graph.graphId)}>
                {t("chat.loop.manager.inspect")}
              </Button>
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
