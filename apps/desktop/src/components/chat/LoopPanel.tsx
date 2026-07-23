import { useState } from "react";
import { useT } from "../../lib/i18n";
import { loopRows, loopStatusTone, loopWarnings, formatCost, type LoopProgress } from "../../lib/loop";
import {
  MAX_LOOP_ITERATIONS,
  parseBudgetInput,
  parseIterationInput,
  parsePositiveIntegerInput,
} from "../../lib/loop-input";
import { Badge, Button, Card, IconChevron, Input, Select, TextArea } from "../ui";

type Props = {
  /** The active tab's live loop feed + final result. */
  progress: LoopProgress;
  /** True while ANY run (chat or loop) is active on the tab — disables Run. */
  running: boolean;
  /** True only while the active operation is a Loop — controls Stop/progress UI. */
  loopRunning: boolean;
  /** Starts a loop run (sends the `loop` frame via the store). */
  onRun: (opts: {
    task: string;
    verifyCommand: string;
    maxIterations?: number;
    budget?: number;
    tokenBudget?: number;
    maxDurationMs?: number;
    maxVerifyRuns?: number;
    verifyTimeoutMs?: number;
    agentTimeoutMs?: number;
    maxAgentRetries?: number;
    requirementMode?: "quick" | "analyze" | "confirm";
  }) => void;
  onResume: (opts: {
    loopId: string;
    addedIterations?: number;
    addedBudget?: number;
    addedTokenBudget?: number;
    addedDurationMs?: number;
    addedVerifyRuns?: number;
    approveRequirements?: boolean;
  }) => void;
  /** Stops a running loop (sends `cancel` via the store). */
  onStop: () => void;
};

const DEFAULT_MAX_ITERATIONS = 8;

/**
 * Collapsible loop-mode panel pinned to the TOP of the chat window. Collapsed
 * by default so normal chat is unaffected. Drives an autonomous
 * run→verify→fix loop on the server and renders the streamed progress.
 */
export function LoopPanel({ progress, running, loopRunning, onRun, onResume, onStop }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [task, setTask] = useState("");
  const [verify, setVerify] = useState("");
  const [maxIterations, setMaxIterations] = useState(String(DEFAULT_MAX_ITERATIONS));
  const [budget, setBudget] = useState("");
  const [tokenBudget, setTokenBudget] = useState("");
  const [maxDuration, setMaxDuration] = useState("");
  const [maxVerifyRuns, setMaxVerifyRuns] = useState("");
  const [verifyTimeout, setVerifyTimeout] = useState("120");
  const [agentTimeout, setAgentTimeout] = useState("1800");
  const [agentRetries, setAgentRetries] = useState("1");
  const [requirementMode, setRequirementMode] = useState<"quick" | "analyze" | "confirm">("quick");
  const [addedIterations, setAddedIterations] = useState("");
  const [addedBudget, setAddedBudget] = useState("");
  const [addedTokens, setAddedTokens] = useState("");
  const [addedDuration, setAddedDuration] = useState("");
  const [addedVerifies, setAddedVerifies] = useState("");

  const max = parseIterationInput(maxIterations);
  const bud = parseBudgetInput(budget);
  const tokenBud = parsePositiveIntegerInput(tokenBudget);
  const duration = parseBudgetInput(maxDuration);
  const verifies = parsePositiveIntegerInput(maxVerifyRuns);
  const verifyLimit = parseBudgetInput(verifyTimeout);
  const agentLimit = parseBudgetInput(agentTimeout);
  const retries = parsePositiveIntegerInput(agentRetries, true);
  const addedIters = parseIterationInput(addedIterations, true);
  const addedBud = parseBudgetInput(addedBudget);
  const addedTokenBud = parsePositiveIntegerInput(addedTokens);
  const addedDurationBudget = parseBudgetInput(addedDuration);
  const addedVerifyBudget = parsePositiveIntegerInput(addedVerifies);

  const canRun =
    !running &&
    task.trim() !== "" &&
    verify.trim() !== "" &&
    !max.error &&
    !bud.error &&
    !tokenBud.error &&
    !duration.error &&
    !verifies.error &&
    !verifyLimit.error &&
    !agentLimit.error &&
    !retries.error;

  const run = () => {
    if (!canRun) return;
    onRun({
      task: task.trim(),
      verifyCommand: verify.trim(),
      ...(max.value !== undefined ? { maxIterations: max.value } : {}),
      ...(bud.value !== undefined ? { budget: bud.value } : {}),
      ...(tokenBud.value !== undefined ? { tokenBudget: tokenBud.value } : {}),
      ...(duration.value !== undefined ? { maxDurationMs: Math.round(duration.value * 1_000) } : {}),
      ...(verifies.value !== undefined ? { maxVerifyRuns: verifies.value } : {}),
      ...(verifyLimit.value !== undefined ? { verifyTimeoutMs: Math.round(verifyLimit.value * 1_000) } : {}),
      ...(agentLimit.value !== undefined ? { agentTimeoutMs: Math.round(agentLimit.value * 1_000) } : {}),
      ...(retries.value !== undefined ? { maxAgentRetries: retries.value } : {}),
      requirementMode,
    });
  };

  const rows = loopRows(progress.events);
  const warnings = loopWarnings(progress.events);
  const result = progress.result;
  const requirementSpec = progress.requirements;
  const acceptanceReview = progress.acceptanceReview;

  return (
    <div className="border-b border-subtle bg-surface-raised/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={open ? t("chat.loop.collapse") : t("chat.loop.expand")}
        className="focus-ring flex w-full items-center gap-2 px-4 py-2 text-left"
      >
        <IconChevron size={14} className={`text-secondary transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="text-xs font-semibold text-primary">{t("chat.loop.title")}</span>
        {loopRunning && progress.events.length === 0 && (
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
            <label htmlFor="loop-task" className="flex flex-col gap-1">
              <span className="text-2xs font-medium uppercase tracking-wide text-tertiary">{t("chat.loop.task")}</span>
              <TextArea
                id="loop-task"
                rows={2}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder={t("chat.loop.taskPlaceholder")}
                disabled={running}
              />
            </label>

            <div className="flex flex-wrap items-end gap-2">
              <div className="flex w-40 flex-col gap-1">
                <span className="text-2xs font-medium uppercase tracking-wide text-tertiary">
                  {t("chat.loop.requirements")}
                </span>
                <Select
                  value={requirementMode}
                  onChange={(value) => setRequirementMode(value as "quick" | "analyze" | "confirm")}
                  disabled={running}
                  ariaLabel={t("chat.loop.requirements")}
                  options={[
                    { value: "quick", label: t("chat.loop.requirements.quick") },
                    { value: "analyze", label: t("chat.loop.requirements.analyze") },
                    { value: "confirm", label: t("chat.loop.requirements.confirm") },
                  ]}
                />
              </div>
              <label htmlFor="loop-verify" className="flex min-w-48 flex-1 flex-col gap-1">
                <span className="text-2xs font-medium uppercase tracking-wide text-tertiary">
                  {t("chat.loop.verify")}
                </span>
                <Input
                  id="loop-verify"
                  value={verify}
                  onChange={(e) => setVerify(e.target.value)}
                  placeholder={t("chat.loop.verifyPlaceholder")}
                  disabled={running}
                  className="font-mono"
                />
              </label>

              <label htmlFor="loop-max-iterations" className="flex w-28 flex-col gap-1">
                <span className="text-2xs font-medium uppercase tracking-wide text-tertiary">
                  {t("chat.loop.maxIterations")}
                </span>
                <Input
                  id="loop-max-iterations"
                  type="number"
                  min={1}
                  max={MAX_LOOP_ITERATIONS}
                  value={maxIterations}
                  onChange={(e) => setMaxIterations(e.target.value)}
                  disabled={running}
                  aria-invalid={max.error !== undefined}
                  className={max.error ? "border-danger" : ""}
                />
                {max.error && <span className="text-2xs text-danger">{t("chat.loop.invalidIterations")}</span>}
              </label>

              <label htmlFor="loop-budget" className="flex w-28 flex-col gap-1">
                <span className="text-2xs font-medium uppercase tracking-wide text-tertiary">
                  {t("chat.loop.budget")}
                </span>
                <Input
                  id="loop-budget"
                  type="number"
                  min={0}
                  step="0.01"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder={t("chat.loop.budgetPlaceholder")}
                  disabled={running}
                  aria-invalid={bud.error !== undefined}
                  className={bud.error ? "border-danger" : ""}
                />
                {bud.error && <span className="text-2xs text-danger">{t("chat.loop.invalidBudget")}</span>}
              </label>

              {loopRunning ? (
                <Button variant="danger" onClick={onStop}>
                  {t("chat.loop.stop")}
                </Button>
              ) : (
                <Button variant="primary" onClick={run} disabled={!canRun}>
                  {t("chat.loop.run")}
                </Button>
              )}
            </div>
            <details className="rounded border border-subtle px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium text-secondary">{t("chat.loop.advanced")}</summary>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                {[
                  ["loop-token-budget", "chat.loop.tokenBudget", tokenBudget, setTokenBudget, tokenBud.error],
                  ["loop-max-duration", "chat.loop.maxDuration", maxDuration, setMaxDuration, duration.error],
                  ["loop-max-verifies", "chat.loop.maxVerifies", maxVerifyRuns, setMaxVerifyRuns, verifies.error],
                  [
                    "loop-verify-timeout",
                    "chat.loop.verifyTimeout",
                    verifyTimeout,
                    setVerifyTimeout,
                    verifyLimit.error,
                  ],
                  ["loop-agent-timeout", "chat.loop.agentTimeout", agentTimeout, setAgentTimeout, agentLimit.error],
                  ["loop-agent-retries", "chat.loop.agentRetries", agentRetries, setAgentRetries, retries.error],
                ].map(([id, label, value, setter, error]) => (
                  <label key={String(id)} htmlFor={String(id)} className="flex w-32 flex-col gap-1">
                    <span className="text-2xs font-medium uppercase tracking-wide text-tertiary">
                      {t(String(label))}
                    </span>
                    <Input
                      id={String(id)}
                      type="number"
                      min={String(id).includes("retries") ? 0 : 1}
                      value={String(value)}
                      onChange={(event) => (setter as (next: string) => void)(event.target.value)}
                      disabled={running}
                      aria-invalid={error !== undefined}
                      className={error ? "border-danger" : ""}
                    />
                  </label>
                ))}
              </div>
            </details>
          </div>

          {(rows.length > 0 || warnings.length > 0 || result) && (
            <Card className="mt-3 flex flex-col gap-1.5 p-3">
              {warnings.map((warning, index) => (
                <div key={`warning-${index}`} className="text-xs text-danger">
                  {warning}
                </div>
              ))}
              {requirementSpec && (
                <div className="mb-1 border-b border-subtle pb-2 text-xs text-secondary">
                  <div className="font-semibold text-primary">{requirementSpec.goal}</div>
                  <div className="mt-1 text-2xs">
                    {t("chat.loop.requirementSummary", {
                      requirements: requirementSpec.requirements.length,
                      criteria: requirementSpec.acceptanceCriteria.length,
                    })}
                  </div>
                  {acceptanceReview && !acceptanceReview.complete && acceptanceReview.gaps.length > 0 && (
                    <ul className="mt-1 list-disc pl-4 text-2xs text-warn">
                      {acceptanceReview.gaps.map((gap) => (
                        <li key={gap}>{gap}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
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
                  {!row.verify && row.liveTail && (
                    <span className="truncate font-mono text-2xs text-tertiary">{row.liveTail}</span>
                  )}
                </div>
              ))}

              {result && (
                <div className={`mt-1 border-t border-subtle pt-2 text-xs ${toneText(loopStatusTone(result.status))}`}>
                  <span className="font-semibold">
                    {t("chat.loop.doneTitle", { status: t(`chat.loop.status.${result.status}`) })}
                  </span>{" "}
                  <span className="text-secondary">
                    {t("chat.loop.doneSummary", {
                      iterations: result.iterations,
                      cost: formatCost(result.costUsd),
                    })}
                  </span>
                  {result.loopId && <span className="ml-2 font-mono text-2xs text-tertiary">{result.loopId}</span>}
                  {result.loopId && !running && (
                    <div className="mt-3 flex flex-wrap items-end gap-2 text-primary">
                      <label htmlFor="loop-added-iterations" className="flex w-32 flex-col gap-1">
                        <span className="text-2xs text-tertiary">{t("chat.loop.addedIterations")}</span>
                        <Input
                          id="loop-added-iterations"
                          value={addedIterations}
                          onChange={(e) => setAddedIterations(e.target.value)}
                          type="number"
                          min={1}
                          max={100}
                          aria-invalid={addedIters.error !== undefined}
                          className={addedIters.error ? "border-danger" : ""}
                          placeholder={t("chat.loop.optional")}
                        />
                        {addedIters.error && (
                          <span className="text-2xs text-danger">{t("chat.loop.invalidIterations")}</span>
                        )}
                      </label>
                      <label htmlFor="loop-added-budget" className="flex w-32 flex-col gap-1">
                        <span className="text-2xs text-tertiary">{t("chat.loop.addedBudget")}</span>
                        <Input
                          id="loop-added-budget"
                          value={addedBudget}
                          onChange={(e) => setAddedBudget(e.target.value)}
                          type="number"
                          min={0}
                          step="0.01"
                          aria-invalid={addedBud.error !== undefined}
                          className={addedBud.error ? "border-danger" : ""}
                          placeholder={t("chat.loop.optional")}
                        />
                        {addedBud.error && <span className="text-2xs text-danger">{t("chat.loop.invalidBudget")}</span>}
                      </label>
                      {[
                        [
                          "loop-added-tokens",
                          "chat.loop.addedTokens",
                          addedTokens,
                          setAddedTokens,
                          addedTokenBud.error,
                        ],
                        [
                          "loop-added-duration",
                          "chat.loop.addedDuration",
                          addedDuration,
                          setAddedDuration,
                          addedDurationBudget.error,
                        ],
                        [
                          "loop-added-verifies",
                          "chat.loop.addedVerifies",
                          addedVerifies,
                          setAddedVerifies,
                          addedVerifyBudget.error,
                        ],
                      ].map(([id, label, value, setter, error]) => (
                        <label key={String(id)} htmlFor={String(id)} className="flex w-32 flex-col gap-1">
                          <span className="text-2xs text-tertiary">{t(String(label))}</span>
                          <Input
                            id={String(id)}
                            value={String(value)}
                            onChange={(event) => (setter as (next: string) => void)(event.target.value)}
                            type="number"
                            min={1}
                            aria-invalid={error !== undefined}
                            className={error ? "border-danger" : ""}
                            placeholder={t("chat.loop.optional")}
                          />
                        </label>
                      ))}
                      <Button
                        variant="primary"
                        disabled={
                          !!addedIters.error ||
                          !!addedBud.error ||
                          !!addedTokenBud.error ||
                          !!addedDurationBudget.error ||
                          !!addedVerifyBudget.error
                        }
                        onClick={() =>
                          onResume({
                            loopId: result.loopId!,
                            ...(addedIters.value !== undefined ? { addedIterations: addedIters.value } : {}),
                            ...(addedBud.value !== undefined ? { addedBudget: addedBud.value } : {}),
                            ...(addedTokenBud.value !== undefined ? { addedTokenBudget: addedTokenBud.value } : {}),
                            ...(addedDurationBudget.value !== undefined
                              ? { addedDurationMs: Math.round(addedDurationBudget.value * 1_000) }
                              : {}),
                            ...(addedVerifyBudget.value !== undefined
                              ? { addedVerifyRuns: addedVerifyBudget.value }
                              : {}),
                            ...(result.status === "requirements_pending" ? { approveRequirements: true } : {}),
                          })
                        }
                      >
                        {result.status === "requirements_pending"
                          ? t("chat.loop.approveRequirements")
                          : t("chat.loop.resume")}
                      </Button>
                    </div>
                  )}
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
