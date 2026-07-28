import { useT } from "../../lib/i18n";
import type { LoopSpeculationSummary } from "../../types";
import { Badge, Button } from "../ui";

export function LoopSpeculationSection(props: {
  speculations: LoopSpeculationSummary[];
  busy: boolean;
  onPromote: (speculationId: string) => void;
}) {
  const t = useT();
  if (props.speculations.length === 0) return null;
  return (
    <div className="mt-2 text-xs text-secondary">
      {props.speculations.map((speculation) => (
        <div
          key={speculation.speculationId}
          className="mt-1 flex flex-wrap items-center gap-2 rounded border border-subtle p-2"
        >
          <span className="font-mono">{speculation.speculationId}</span>
          <Badge tone={speculation.status === "completed" || speculation.status === "promoted" ? "ok" : "neutral"}>
            {speculation.status}
          </Badge>
          <span>
            {speculation.candidates.length} {t("chat.loop.manager.candidates")} · {t("chat.loop.manager.winner")}{" "}
            {speculation.winnerId ?? "—"}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={props.busy || speculation.status !== "completed" || !speculation.winnerId}
            onClick={() => props.onPromote(speculation.speculationId)}
          >
            {t("chat.loop.manager.promote")}
          </Button>
        </div>
      ))}
    </div>
  );
}
