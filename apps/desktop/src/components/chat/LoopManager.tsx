import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import type { LoopHistoryEntry, LoopStateSummary } from "../../types";
import { Badge, Button } from "../ui";

type Props = { running: boolean; onResume: (opts: { loopId: string }) => void };

export function LoopManager({ running, onResume }: Props) {
  const t = useT();
  const [loops, setLoops] = useState<LoopStateSummary[]>([]);
  const [selected, setSelected] = useState<string>();
  const [history, setHistory] = useState<LoopHistoryEntry[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setLoops(await api.loops());
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const inspect = async (loopId: string) => {
    setSelected(loopId);
    try {
      setHistory(await api.loopHistory(loopId, 0, 100));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
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
      if (selected === loopId) {
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
        </div>
      )}
    </details>
  );
}
