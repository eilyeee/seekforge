import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { LatestRequest } from "../../views/async-coordination";
import { useT } from "../../lib/i18n";
import type { LoopDagSummary, LoopHistoryEntry, LoopStateSummary } from "../../types";
import { Badge, Button } from "../ui";

type Props = { running: boolean; onResume: (opts: { loopId: string }) => void };

export function LoopManager({ running, onResume }: Props) {
  const t = useT();
  const [loops, setLoops] = useState<LoopStateSummary[]>([]);
  const [selected, setSelected] = useState<string>();
  const [history, setHistory] = useState<LoopHistoryEntry[]>([]);
  const [dags, setDags] = useState<LoopDagSummary[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refreshRequests = useRef(new LatestRequest());
  const historyRequests = useRef(new LatestRequest());
  const selectedRef = useRef<string>();
  const refresh = useCallback(async () => {
    const request = refreshRequests.current.begin();
    setBusy(true);
    try {
      const [nextLoops, nextDags] = await Promise.all([
        api.loops({ q: query || undefined, status: status || undefined, limit: 100 }),
        api.loopDags(),
      ]);
      if (refreshRequests.current.isCurrent(request)) {
        setLoops(nextLoops);
        setDags(nextDags);
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
    try {
      const nextHistory = await api.loopHistory(loopId, 0, 100);
      if (historyRequests.current.isCurrent(request) && selectedRef.current === loopId) {
        setHistory(nextHistory);
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
        <div className="mt-2 max-h-48 overflow-auto rounded bg-surface p-2 font-mono text-2xs text-secondary">
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
      )}
      {dags.length > 0 && (
        <div className="mt-2 text-xs text-secondary">
          {dags.map((dag) => (
            <div key={dag.dagId}>
              {dag.dagId} · {dag.completedAt ? t("chat.loop.manager.completed") : t("chat.loop.manager.active")} ·{" "}
              {dag.results.length} nodes · ${dag.spentCost.toFixed(4)}
            </div>
          ))}
        </div>
      )}
    </details>
  );
}
