import { useState } from "react";
import { useT } from "../../lib/i18n";
import { loopRows, loopStatusTone, formatCost, type LoopProgress } from "../../lib/loop";
import { Badge, Button, Card, IconChevron, Input, TextArea } from "../ui";

type Props = {
  /** The active tab's live loop feed + final result. */
  progress: LoopProgress;
  /** True while ANY run (chat or loop) is active on the tab — disables Run. */
  running: boolean;
  /** Starts a loop run (sends the `loop` frame via the store). */
  onRun: (opts: { task: string; verifyCommand: string; maxIterations?: number; budget?: number }) => void;
  /** Stops a running loop (sends `cancel` via the store). */
  onStop: () => void;
};

const DEFAULT_MAX_ITERATIONS = 8;

/**
 * Collapsible loop-mode panel pinned to the TOP of the chat window. Collapsed
 * by default so normal chat is unaffected. Drives an autonomous
 * run→verify→fix loop on the server and renders the streamed progress.
 */
export function LoopPanel({ progress, running, onRun, onStop }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [task, setTask] = useState("");
  const [verify, setVerify] = useState("");
  const [maxIterations, setMaxIterations] = useState(String(DEFAULT_MAX_ITERATIONS));
  const [budget, setBudget] = useState("");

  const canRun = !running && task.trim() !== "" && verify.trim() !== "";

  const run = () => {
    if (!canRun) return;
    const max = Number.parseInt(maxIterations, 10);
    const bud = Number.parseFloat(budget);
    onRun({
      task: task.trim(),
      verifyCommand: verify.trim(),
      ...(Number.isFinite(max) && max > 0 ? { maxIterations: max } : {}),
      ...(Number.isFinite(bud) && bud > 0 ? { budget: bud } : {}),
    });
  };

  const rows = loopRows(progress.events);
  const result = progress.result;

  return (
    <div className="border-b border-subtle bg-surface-raised/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={open ? t("chat.loop.collapse") : t("chat.loop.expand")}
        className="focus-ring flex w-full items-center gap-2 px-4 py-2 text-left"
      >
        <IconChevron
          size={14}
          className={`text-secondary transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="text-xs font-semibold text-primary">{t("chat.loop.title")}</span>
        {running && progress.events.length === 0 && (
          <span className="flex items-center gap-1.5 text-2xs text-warn">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn" />
            {t("chat.loop.waiting")}
          </span>
        )}
        {result && (
          <Badge tone={loopStatusTone(result.status)} className="ml-1">
            {t(`chat.loop.status.${result.status}`)}
          </Badge>
        )}
      </button>

      {open && (
        <div className="px-4 pb-3">
          <p className="mb-3 text-xs text-secondary">{t("chat.loop.explain")}</p>

          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-2xs font-medium uppercase tracking-wide text-tertiary">
                {t("chat.loop.task")}
              </span>
              <TextArea
                rows={2}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder={t("chat.loop.taskPlaceholder")}
                disabled={running}
              />
            </label>

            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-48 flex-1 flex-col gap-1">
                <span className="text-2xs font-medium uppercase tracking-wide text-tertiary">
                  {t("chat.loop.verify")}
                </span>
                <Input
                  value={verify}
                  onChange={(e) => setVerify(e.target.value)}
                  placeholder={t("chat.loop.verifyPlaceholder")}
                  disabled={running}
                  className="font-mono"
                />
              </label>

              <label className="flex w-28 flex-col gap-1">
                <span className="text-2xs font-medium uppercase tracking-wide text-tertiary">
                  {t("chat.loop.maxIterations")}
                </span>
                <Input
                  type="number"
                  min={1}
                  value={maxIterations}
                  onChange={(e) => setMaxIterations(e.target.value)}
                  disabled={running}
                />
              </label>

              <label className="flex w-28 flex-col gap-1">
                <span className="text-2xs font-medium uppercase tracking-wide text-tertiary">
                  {t("chat.loop.budget")}
                </span>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder={t("chat.loop.budgetPlaceholder")}
                  disabled={running}
                />
              </label>

              {running ? (
                <Button variant="danger" onClick={onStop}>
                  {t("chat.loop.stop")}
                </Button>
              ) : (
                <Button variant="primary" onClick={run} disabled={!canRun}>
                  {t("chat.loop.run")}
                </Button>
              )}
            </div>
          </div>

          {(rows.length > 0 || result) && (
            <Card className="mt-3 flex flex-col gap-1.5 p-3">
              {rows.map((row) => (
                  <div key={row.iteration} className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge tone="neutral">{t("chat.loop.iteration", { n: row.iteration })}</Badge>
                    {row.costUsd !== null && (
                      <span className="font-mono text-2xs text-secondary">
                        {t("chat.loop.runCost", { cost: formatCost(row.costUsd) })}
                      </span>
                    )}
                    {row.verify && (
                      <>
                        <Badge tone={row.verify.passed ? "ok" : "danger"}>
                          {row.verify.passed
                            ? t("chat.loop.verifyPass")
                            : t("chat.loop.verifyFail", { code: row.verify.code })}
                        </Badge>
                        {row.verify.tail && (
                          <span className="truncate font-mono text-2xs text-tertiary">{row.verify.tail}</span>
                        )}
                      </>
                    )}
                  </div>
                ))}

                {result && (
                  <div
                    className={`mt-1 border-t border-subtle pt-2 text-xs ${toneText(loopStatusTone(result.status))}`}
                  >
                    <span className="font-semibold">
                      {t("chat.loop.doneTitle", { status: t(`chat.loop.status.${result.status}`) })}
                    </span>{" "}
                    <span className="text-secondary">
                      {t("chat.loop.doneSummary", {
                        iterations: result.iterations,
                        cost: formatCost(result.costUsd),
                      })}
                    </span>
                  </div>
                )}
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

/** Loop tone → text color class for the summary line. */
function toneText(tone: "ok" | "warn" | "danger"): string {
  if (tone === "ok") return "text-ok";
  if (tone === "warn") return "text-warn";
  return "text-danger";
}
