import { useT } from "../../lib/i18n";
import type { LoopStateSummary } from "../../types";
import { Badge, Button } from "../ui";

export function LoopListSection(props: {
  loops: LoopStateSummary[];
  busy: boolean;
  running: boolean;
  onInspect: (loopId: string) => void;
  onPriority: (loop: LoopStateSummary, delta: number) => void;
  onResume: (loopId: string) => void;
  onControl: (loopId: string, operation: "pause" | "resume" | "steer") => void;
  onRemove: (loopId: string) => void;
}) {
  const t = useT();
  return (
    <div className="mt-2 flex flex-col gap-1">
      {props.loops.length === 0 && <p className="text-xs text-tertiary">{t("chat.loop.manager.empty")}</p>}
      {props.loops.map((loop) => (
        <div key={loop.loopId} className="rounded border border-subtle bg-surface px-2 py-1.5 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="font-mono text-accent" onClick={() => props.onInspect(loop.loopId)}>
              {loop.loopId}
            </button>
            <Badge tone="neutral">{loop.status}</Badge>
            {loop.phase && <Badge tone="neutral">{loop.phase}</Badge>}
            <span className="min-w-0 flex-1 truncate text-secondary">{loop.task}</span>
            <span className="text-tertiary">
              {loop.iterations}/{loop.maxIterations}
            </span>
            <span className="text-tertiary">{t("chat.loop.manager.priority", { value: loop.priority ?? 0 })}</span>
            {loop.delivery?.ci && (
              <Badge tone={loop.delivery.ci.status === "passed" ? "ok" : "neutral"}>
                CI {loop.delivery.ci.status} · {loop.delivery.ci.repairAttempts}/{loop.delivery.ci.maxRepairs}
              </Badge>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={props.busy || (loop.priority ?? 0) <= -10}
              onClick={() => props.onPriority(loop, -1)}
            >
              −
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={props.busy || (loop.priority ?? 0) >= 10}
              onClick={() => props.onPriority(loop, 1)}
            >
              +
            </Button>
            <Button size="sm" disabled={props.running || props.busy} onClick={() => props.onResume(loop.loopId)}>
              {t("chat.loop.resume")}
            </Button>
            {(loop.status === "running" || loop.status === "paused") && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={props.busy}
                  onClick={() => props.onControl(loop.loopId, loop.status === "paused" ? "resume" : "pause")}
                >
                  {loop.status === "paused" ? t("chat.loop.manager.continue") : t("chat.loop.manager.pause")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={props.busy}
                  onClick={() => props.onControl(loop.loopId, "steer")}
                >
                  {t("chat.loop.manager.steer")}
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={props.running || props.busy}
              onClick={() => props.onRemove(loop.loopId)}
            >
              {t("chat.loop.manager.delete")}
            </Button>
          </div>
          {loop.recovery && (
            <p className="mt-1 text-tertiary">
              {t("chat.loop.graph.recoveryAttempt", { value: loop.recovery.attempts })}
              {loop.recovery.nextAttemptAt
                ? ` · ${t("chat.loop.graph.recoveryNext", { value: loop.recovery.nextAttemptAt })}`
                : ""}
              {loop.recovery.lastError
                ? ` · ${t("chat.loop.graph.recoveryError", { value: loop.recovery.lastError })}`
                : ""}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
