import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { LatestRequest } from "../../views/async-coordination";
import { useT } from "../../lib/i18n";
import type {
  LoopDagResourceReport,
  LoopDagSummary,
  LoopEvidenceReport,
  LoopHistoryEntry,
  LoopSpeculationSummary,
  LoopStateSummary,
} from "../../types";
import { Badge, Button } from "../ui";

type Props = { running: boolean; onResume: (opts: { loopId: string }) => void };

export function LoopManager({ running, onResume }: Props) {
  const t = useT();
  const [loops, setLoops] = useState<LoopStateSummary[]>([]);
  const [selected, setSelected] = useState<string>();
  const [history, setHistory] = useState<LoopHistoryEntry[]>([]);
  const [evidence, setEvidence] = useState<LoopEvidenceReport>();
  const [dags, setDags] = useState<LoopDagSummary[]>([]);
  const [dagResources, setDagResources] = useState<Record<string, LoopDagResourceReport>>({});
  const [speculations, setSpeculations] = useState<LoopSpeculationSummary[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refreshRequests = useRef(new LatestRequest());
  const historyRequests = useRef(new LatestRequest());
  const dagRequests = useRef(new LatestRequest());
  const operationRequests = useRef(new LatestRequest());
  const selectedRef = useRef<string>();
  const refresh = useCallback(async () => {
    const request = refreshRequests.current.begin();
    setBusy(true);
    try {
      const [nextLoops, nextDags, nextSpeculations] = await Promise.all([
        api.loops({ q: query || undefined, status: status || undefined, limit: 100 }),
        api.loopDags(),
        api.loopSpeculations(),
      ]);
      if (refreshRequests.current.isCurrent(request)) {
        setLoops(nextLoops);
        setDags(nextDags);
        setSpeculations(nextSpeculations);
        setError("");
      }
    } catch (caught) {
      if (refreshRequests.current.isCurrent(request)) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (refreshRequests.current.isCurrent(request)) setBusy(false);
    }
  }, [query, status]);
  useEffect(() => void refresh(), [refresh]);
  useEffect(
    () => () => {
      refreshRequests.current.invalidate();
      historyRequests.current.invalidate();
      dagRequests.current.invalidate();
      operationRequests.current.invalidate();
    },
    [],
  );
  useEffect(() => {
    if (!running && !selected) return;
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh, running, selected]);

  const inspect = async (loopId: string) => {
    const request = historyRequests.current.begin();
    selectedRef.current = loopId;
    setSelected(loopId);
    setHistory([]);
    setEvidence(undefined);
    try {
      const [nextHistory, nextEvidence] = await Promise.all([
        api.loopHistory(loopId, 0, 100),
        api.loopEvidence(loopId),
      ]);
      if (historyRequests.current.isCurrent(request) && selectedRef.current === loopId) {
        setHistory(nextHistory);
        setEvidence(nextEvidence);
        setError("");
      }
    } catch (caught) {
      if (historyRequests.current.isCurrent(request) && selectedRef.current === loopId) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }
  };
  const loadMoreHistory = async () => {
    const loopId = selectedRef.current;
    if (!loopId) return;
    const cursor = history.at(-1)?.seq ?? 0;
    const request = historyRequests.current.begin();
    try {
      const next = await api.loopHistory(loopId, cursor, 100);
      if (historyRequests.current.isCurrent(request) && selectedRef.current === loopId) {
        setHistory((current) => [...current, ...next]);
        setError("");
      }
    } catch (caught) {
      if (historyRequests.current.isCurrent(request) && selectedRef.current === loopId) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }
  };
  const control = async (loopId: string, operation: "pause" | "resume" | "steer") => {
    const message = operation === "steer" ? window.prompt(t("chat.loop.manager.steerPrompt"))?.trim() : undefined;
    if (operation === "steer" && !message) return;
    setBusy(true);
    try {
      await api.loopControl(loopId, operation === "steer" ? { operation, message: message! } : { operation });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  };
  const recover = async () => {
    setBusy(true);
    try {
      await api.loopRecover();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  };
  const prune = async () => {
    if (!window.confirm(t("chat.loop.manager.pruneConfirm"))) return;
    setBusy(true);
    try {
      await api.loopPrune({ maxAgeDays: 30, maxTerminalCount: 50 });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  };
  const remove = async (loopId: string) => {
    if (!window.confirm(t("chat.loop.manager.deleteConfirm"))) return;
    setBusy(true);
    try {
      await api.loopDelete(loopId);
      if (selectedRef.current === loopId) {
        selectedRef.current = undefined;
        historyRequests.current.invalidate();
        setSelected(undefined);
        setHistory([]);
        setEvidence(undefined);
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  };
  const changePriority = async (loop: LoopStateSummary, delta: number) => {
    setBusy(true);
    try {
      await api.loopPriority(loop.loopId, Math.max(-10, Math.min(10, (loop.priority ?? 0) + delta)));
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  };
  const inspectDag = async (dagId: string) => {
    const request = dagRequests.current.begin();
    setBusy(true);
    try {
      const report = await api.loopDagResources(dagId);
      if (dagRequests.current.isCurrent(request)) {
        setDagResources((current) => ({ ...current, [dagId]: report }));
        setError("");
      }
    } catch (caught) {
      if (dagRequests.current.isCurrent(request)) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (dagRequests.current.isCurrent(request)) setBusy(false);
    }
  };
  const dagAction = async (dagId: string, operation: "archive" | "prune" | "promote") => {
    if (
      operation !== "archive" &&
      !window.confirm(
        t("chat.loop.manager.resourceConfirm", {
          action: operation === "promote" ? t("chat.loop.manager.promote") : t("chat.loop.manager.pruneResources"),
          id: dagId,
        }),
      )
    )
      return;
    const request = operationRequests.current.begin();
    setBusy(true);
    try {
      await api.loopDagResourceAction(dagId, { operation, ...(operation === "promote" ? { target: "fan-in" } : {}) });
      if (!operationRequests.current.isCurrent(request)) return;
      await refresh();
      if (operationRequests.current.isCurrent(request) && operation !== "prune") await inspectDag(dagId);
    } catch (caught) {
      if (operationRequests.current.isCurrent(request)) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (operationRequests.current.isCurrent(request)) setBusy(false);
    }
  };
  const promoteSpeculation = async (speculationId: string) => {
    if (
      !window.confirm(
        t("chat.loop.manager.resourceConfirm", {
          action: t("chat.loop.manager.promote"),
          id: speculationId,
        }),
      )
    )
      return;
    const request = operationRequests.current.begin();
    setBusy(true);
    try {
      await api.loopSpeculationPromote(speculationId);
      if (operationRequests.current.isCurrent(request)) await refresh();
    } catch (caught) {
      if (operationRequests.current.isCurrent(request)) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (operationRequests.current.isCurrent(request)) setBusy(false);
    }
  };

  return (
    <details className="mt-2 rounded border border-subtle p-2">
      <summary className="cursor-pointer text-xs font-medium text-secondary">{t("chat.loop.manager.title")}</summary>
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          className="min-w-40 rounded border border-subtle bg-surface px-2 text-xs"
          value={query}
          placeholder={t("chat.loop.manager.filter")}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className="rounded border border-subtle bg-surface px-2 text-xs"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">{t("chat.loop.manager.allStatuses")}</option>
          {["running", "paused", "passed", "failed", "interrupted", "budget", "no_progress"].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
          {t("chat.loop.manager.refresh")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy || running} onClick={() => void recover()}>
          {t("chat.loop.manager.recover")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy || running} onClick={() => void prune()}>
          {t("chat.loop.manager.prune")}
        </Button>
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      <div className="mt-2 flex flex-col gap-1">
        {loops.length === 0 && <p className="text-xs text-tertiary">{t("chat.loop.manager.empty")}</p>}
        {loops.map((loop) => (
          <div key={loop.loopId} className="rounded border border-subtle bg-surface px-2 py-1.5 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="font-mono text-accent" onClick={() => void inspect(loop.loopId)}>
                {loop.loopId}
              </button>
              <Badge tone="neutral">{loop.status}</Badge>
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
                disabled={busy || (loop.priority ?? 0) <= -10}
                onClick={() => void changePriority(loop, -1)}
              >
                −
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || (loop.priority ?? 0) >= 10}
                onClick={() => void changePriority(loop, 1)}
              >
                +
              </Button>
              <Button size="sm" disabled={running || busy} onClick={() => onResume({ loopId: loop.loopId })}>
                {t("chat.loop.resume")}
              </Button>
              {(loop.status === "running" || loop.status === "paused") && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void control(loop.loopId, loop.status === "paused" ? "resume" : "pause")}
                  >
                    {loop.status === "paused" ? t("chat.loop.manager.continue") : t("chat.loop.manager.pause")}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void control(loop.loopId, "steer")}>
                    {t("chat.loop.manager.steer")}
                  </Button>
                </>
              )}
              <Button size="sm" variant="ghost" disabled={running || busy} onClick={() => void remove(loop.loopId)}>
                {t("chat.loop.manager.delete")}
              </Button>
            </div>
          </div>
        ))}
      </div>
      {selected && (
        <div className="mt-2 rounded border border-subtle bg-surface p-2 text-xs text-secondary">
          {evidence && (
            <div className="mb-2 grid gap-2 md:grid-cols-3">
              <section>
                <p className="font-medium text-primary">{t("chat.loop.manager.verification")}</p>
                {evidence.verification.map((stage) => (
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
                {evidence.criteria.length === 0 && <p className="mt-1 text-tertiary">—</p>}
                {evidence.criteria.map((criterion) => (
                  <div key={criterion.id} className="mt-1">
                    <Badge tone={criterion.status === "met" ? "ok" : "neutral"}>{criterion.status}</Badge>{" "}
                    {criterion.id} · {criterion.text}
                    {criterion.evidence.length > 0 && (
                      <p className="truncate font-mono text-2xs text-tertiary">{criterion.evidence.join(" · ")}</p>
                    )}
                  </div>
                ))}
              </section>
              <section>
                <p className="font-medium text-primary">{t("chat.loop.manager.timeline")}</p>
                {evidence.iterations.map((iteration) => (
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
            {history.length === 0
              ? t("chat.loop.manager.noHistory")
              : history.map((entry) => (
                  <div key={entry.seq}>
                    {entry.seq} · {entry.ts} · {entry.event.type}
                  </div>
                ))}
            {history.length > 0 && history.length % 100 === 0 && (
              <Button size="sm" variant="ghost" onClick={() => void loadMoreHistory()}>
                {t("chat.loop.manager.loadMore")}
              </Button>
            )}
          </div>
        </div>
      )}
      {dags.length > 0 && (
        <div className="mt-2 text-xs text-secondary">
          {dags.map((dag) => (
            <div key={dag.dagId} className="mt-1 rounded border border-subtle p-2">
              {dag.dagId} · {dag.completedAt ? t("chat.loop.manager.completed") : t("chat.loop.manager.active")} ·{" "}
              {dag.results.length} {t("chat.loop.manager.nodes")} · ${dag.spentCost.toFixed(4)}
              {dag.fanIn && (
                <Badge tone={dag.fanIn.status === "passed" ? "ok" : "danger"}>fan-in: {dag.fanIn.status}</Badge>
              )}
              <div className="ml-2 inline-flex gap-1">
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void inspectDag(dag.dagId)}>
                  {t("chat.loop.manager.inspect")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !dag.completedAt}
                  onClick={() => void dagAction(dag.dagId, "archive")}
                >
                  {t("chat.loop.manager.archive")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !dag.fanIn}
                  onClick={() => void dagAction(dag.dagId, "promote")}
                >
                  {t("chat.loop.manager.promote")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !dagResources[dag.dagId]?.archived}
                  onClick={() => void dagAction(dag.dagId, "prune")}
                >
                  {t("chat.loop.manager.pruneResources")}
                </Button>
              </div>
              {dagResources[dag.dagId] && (
                <p className="mt-1 text-tertiary">
                  {((dagResources[dag.dagId]?.totalBytes ?? 0) / 1024 / 1024).toFixed(2)} MiB ·{" "}
                  {dagResources[dag.dagId]?.worktrees.length ?? 0} {t("chat.loop.manager.worktrees")} ·{" "}
                  {dagResources[dag.dagId]?.archived
                    ? t("chat.loop.manager.archived")
                    : t("chat.loop.manager.retained")}
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
          ))}
        </div>
      )}
      {speculations.length > 0 && (
        <div className="mt-2 text-xs text-secondary">
          {speculations.map((speculation) => (
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
                disabled={busy || speculation.status !== "completed" || !speculation.winnerId}
                onClick={() => void promoteSpeculation(speculation.speculationId)}
              >
                {t("chat.loop.manager.promote")}
              </Button>
            </div>
          ))}
        </div>
      )}
    </details>
  );
}
