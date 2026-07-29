import { useT } from "../../lib/i18n";
import type { LoopDagResourceReport, LoopDagSummary } from "../../types";
import { Badge, Button } from "../ui";

export function LoopDagSection(props: {
  dags: LoopDagSummary[];
  resources: Record<string, LoopDagResourceReport>;
  busy: boolean;
  onInspect: (dagId: string) => void;
  onAction: (dagId: string, operation: "archive" | "prune" | "promote") => void;
}) {
  const t = useT();
  if (props.dags.length === 0) return null;
  return (
    <div className="mt-2 text-xs text-secondary">
      {props.dags.map((dag) => {
        const resources = props.resources[dag.dagId];
        return (
          <div key={dag.dagId} className="mt-1 rounded border border-subtle p-2">
            {dag.dagId} · {dag.completedAt ? t("chat.loop.manager.completed") : t("chat.loop.manager.active")} ·{" "}
            {dag.results.length} {t("chat.loop.manager.nodes")} · ${dag.spentCost.toFixed(4)} ·{" "}
            {(dag.elapsedMs / 1000).toFixed(1)}s
            {dag.fanIn && (
              <Badge tone={dag.fanIn.status === "passed" ? "ok" : "danger"}>fan-in: {dag.fanIn.status}</Badge>
            )}
            <div className="ml-2 inline-flex gap-1">
              <Button size="sm" variant="ghost" disabled={props.busy} onClick={() => props.onInspect(dag.dagId)}>
                {t("chat.loop.manager.inspect")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={props.busy || !dag.completedAt}
                onClick={() => props.onAction(dag.dagId, "archive")}
              >
                {t("chat.loop.manager.archive")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={props.busy || !dag.fanIn}
                onClick={() => props.onAction(dag.dagId, "promote")}
              >
                {t("chat.loop.manager.promote")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={props.busy || !resources?.archived}
                onClick={() => props.onAction(dag.dagId, "prune")}
              >
                {t("chat.loop.manager.pruneResources")}
              </Button>
            </div>
            {resources && (
              <p className="mt-1 text-tertiary">
                {(resources.totalBytes / 1024 / 1024).toFixed(2)} MiB · {resources.worktrees.length}{" "}
                {t("chat.loop.manager.worktrees")} ·{" "}
                {resources.archived ? t("chat.loop.manager.archived") : t("chat.loop.manager.retained")}
              </p>
            )}
            <div className="mt-1 flex flex-wrap gap-1">
              {dag.results.map((node) => (
                <Badge key={node.id} tone={node.status === "passed" ? "ok" : "neutral"}>
                  {node.id}: {node.status}
                </Badge>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
