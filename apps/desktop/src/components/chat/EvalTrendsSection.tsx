import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { parseControlPlaneScenarioInput } from "../../lib/control-plane-input";
import { useT } from "../../lib/i18n";
import type { ControlPlaneEvalReport, EvalTrendEntry } from "../../types";
import { Button } from "../ui";

function points(entries: EvalTrendEntry[], select: (entry: EvalTrendEntry) => number): string {
  if (entries.length === 0) return "";
  const values = entries.map(select);
  const max = Math.max(...values, 1e-9);
  const width = 300;
  const height = 80;
  return values
    .map((value, index) => {
      const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
      return `${x.toFixed(1)},${(height - (value / max) * height).toFixed(1)}`;
    })
    .join(" ");
}

export function EvalTrendsSection(props: { workspaceId?: string }) {
  const t = useT();
  const generation = useRef(0);
  const [entries, setEntries] = useState<EvalTrendEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [controlPlane, setControlPlane] = useState<ControlPlaneEvalReport>();
  const [scenarioText, setScenarioText] = useState("");

  const refresh = async () => {
    const request = ++generation.current;
    setBusy(true);
    try {
      const [trendsResult, controlPlaneResult] = await Promise.allSettled([
        api.evalTrends(40, props.workspaceId),
        api.evalControlPlane(props.workspaceId),
      ]);
      if (trendsResult.status === "rejected") throw trendsResult.reason;
      if (generation.current === request) {
        setEntries(trendsResult.value.entries);
        setControlPlane(controlPlaneResult.status === "fulfilled" ? controlPlaneResult.value : undefined);
        setError("");
      }
    } catch (caught) {
      if (generation.current === request) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (generation.current === request) setBusy(false);
    }
  };

  const evaluateCustom = async () => {
    const request = ++generation.current;
    setBusy(true);
    try {
      const scenarios = parseControlPlaneScenarioInput(scenarioText);
      const report = await api.evalControlPlaneEvaluate(scenarios, props.workspaceId);
      if (generation.current === request) {
        setControlPlane(report);
        setError("");
      }
    } catch (caught) {
      if (generation.current === request) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (generation.current === request) setBusy(false);
    }
  };

  useEffect(() => {
    setEntries([]);
    setControlPlane(undefined);
    setScenarioText("");
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [props.workspaceId]);

  return (
    <details className="mt-3 rounded border border-subtle p-2 text-xs text-secondary">
      <summary className="cursor-pointer font-medium">{t("chat.loop.eval.title")}</summary>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-tertiary">
          {entries.length} {t("chat.loop.eval.reports")}
        </span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
          {t("chat.loop.eval.refresh")}
        </Button>
      </div>
      {error && <p className="mt-2 text-danger">{error}</p>}
      {controlPlane && (
        <div className="mt-2 rounded border border-subtle p-2">
          <p className="font-medium">{t("chat.loop.eval.controlPlane")}</p>
          <p className="text-tertiary">
            {t("chat.loop.eval.controlPlaneSummary", {
              improved: controlPlane.summary.improved,
              neutral: controlPlane.summary.neutral,
              regressed: controlPlane.summary.regressed,
            })}
          </p>
          {controlPlane.scenarios.map((scenario) => (
            <div key={scenario.id} className="mt-1 flex flex-wrap items-center gap-1 text-tertiary">
              <span>
                {scenario.id} · {scenario.samples} {t("chat.loop.eval.days")} · {t("chat.loop.eval.recoveryRate")}{" "}
                {(scenario.baselineRecoveryRate * 100).toFixed(0)}% →{" "}
                {(scenario.controlledRecoveryRate * 100).toFixed(0)}% · {t("chat.loop.eval.recoveryTime")}{" "}
                {(scenario.recoveryTimeImprovement * 100).toFixed(0)}% · {t("chat.loop.eval.cost")}{" "}
                {(scenario.costImprovement * 100).toFixed(0)}%
              </span>
              <span className="rounded bg-surface-overlay px-1">{t(`chat.loop.eval.verdict.${scenario.verdict}`)}</span>
            </div>
          ))}
          <details className="mt-2">
            <summary className="cursor-pointer">{t("chat.loop.eval.customScenario")}</summary>
            <textarea
              className="mt-2 h-28 w-full rounded border border-subtle bg-surface p-2 font-mono text-2xs"
              value={scenarioText}
              onChange={(event) => setScenarioText(event.target.value)}
              placeholder={t("chat.loop.eval.customScenarioPlaceholder")}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !scenarioText.trim()}
              onClick={() => void evaluateCustom()}
            >
              {t("chat.loop.eval.evaluateScenario")}
            </Button>
          </details>
        </div>
      )}
      {entries.length === 0 ? (
        <p className="mt-2 text-tertiary">{t("chat.loop.eval.empty")}</p>
      ) : (
        <>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <figure className="rounded border border-subtle p-2">
              <figcaption>{t("chat.loop.eval.success")}</figcaption>
              <svg aria-label={t("chat.loop.eval.success")} viewBox="0 0 300 80" className="mt-1 w-full" role="img">
                <polyline
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  points={points(entries, (entry) => entry.successRate)}
                />
              </svg>
            </figure>
            <figure className="rounded border border-subtle p-2">
              <figcaption>{t("chat.loop.eval.cost")}</figcaption>
              <svg aria-label={t("chat.loop.eval.cost")} viewBox="0 0 300 80" className="mt-1 w-full" role="img">
                <polyline
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  points={points(entries, (entry) => entry.totalCostUsd)}
                />
              </svg>
            </figure>
          </div>
          <div className="mt-2 space-y-1">
            {entries
              .slice()
              .reverse()
              .slice(0, 10)
              .map((entry) => (
                <p key={`${entry.generatedAt}-${entry.report}`} className="break-words text-tertiary">
                  {new Date(entry.generatedAt).toLocaleString()} · {entry.label} ·{" "}
                  {(entry.successRate * 100).toFixed(1)}% · ${entry.totalCostUsd.toFixed(4)}
                </p>
              ))}
          </div>
        </>
      )}
    </details>
  );
}
