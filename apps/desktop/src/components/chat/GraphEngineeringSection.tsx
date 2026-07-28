import { useT } from "../../lib/i18n";
import type { EngineeringGraphSummary } from "../../types";
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
  busy: boolean;
  onRemove: (graphId: string) => void;
}) {
  const t = useT();
  if (props.graphs.length === 0) return null;
  return (
    <section className="mt-3 text-xs text-secondary" aria-label={t("chat.loop.graph.title")}>
      <p className="font-medium">{t("chat.loop.graph.title")}</p>
      {props.graphs.map((graph) => (
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
          <div className="mt-2 space-y-1 text-tertiary">
            {graph.events.slice(-8).map((event) => (
              <p key={event.sequence}>
                #{event.sequence} {event.type}
                {event.nodeId ? ` · ${event.nodeId}` : ""}
                {event.message ? ` · ${event.message}` : ""}
              </p>
            ))}
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={props.busy || graph.status === "running"}
            onClick={() => props.onRemove(graph.graphId)}
          >
            {t("chat.loop.manager.delete")}
          </Button>
        </details>
      ))}
    </section>
  );
}
