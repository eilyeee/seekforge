import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useStore } from "../store";
import { useT } from "../lib/i18n";
import { Badge, Button, Card, IconSettings, Input } from "../components/ui";
import type { DoctorReport, RunEventSummary, RunRecordSummary, WorkspaceOperationalDiagnostics } from "../types";
import { fetchRunEventTail } from "../lib/run-events";
import { filterRuns, summarizeRuns, type RunSourceFilter, type RunStatusFilter } from "../lib/run-control";
import { useWorkspaceAsyncCoordinator } from "./use-workspace-async";

type Check = { label: string; value: string; ok: boolean };

/** Maps a DoctorReport into a flat list of labelled ok/warn checks. */
function toChecks(t: ReturnType<typeof useT>, r: DoctorReport): Check[] {
  return [
    {
      label: t("diagnostics.apiKey"),
      value: r.apiKeyConfigured ? t("diagnostics.apiKeyConfigured") : t("diagnostics.apiKeyMissing"),
      ok: r.apiKeyConfigured,
    },
    { label: t("diagnostics.node"), value: r.nodeVersion, ok: true },
    {
      label: t("diagnostics.git"),
      value: r.git ?? t("diagnostics.gitMissing"),
      ok: r.git !== null,
    },
    {
      label: t("diagnostics.runtimeBin"),
      value: !r.runtimeBin.set
        ? t("diagnostics.runtimeBinUnset")
        : r.runtimeBin.exists
          ? t("diagnostics.runtimeBinOk")
          : t("diagnostics.runtimeBinMissing"),
      // Unset is fine (bundled runtime); set-but-missing is a warning.
      ok: !r.runtimeBin.set || r.runtimeBin.exists,
    },
    {
      label: t("diagnostics.mcpServers"),
      value: t("diagnostics.mcpServersCount", { count: r.mcpServerCount }),
      ok: true,
    },
    {
      label: t("diagnostics.models"),
      value: r.modelCount > 0 ? t("diagnostics.modelsCount", { count: r.modelCount }) : t("diagnostics.modelsNone"),
      ok: r.modelCount > 0,
    },
    { label: t("diagnostics.workspace"), value: r.workspace, ok: true },
  ];
}

export function DiagnosticsView() {
  const t = useT();
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [runs, setRuns] = useState<RunRecordSummary[]>([]);
  const [operations, setOperations] = useState<WorkspaceOperationalDiagnostics | null>(null);
  const [events, setEvents] = useState<Record<string, RunEventSummary[]>>({});
  const [runQuery, setRunQuery] = useState("");
  const [runStatus, setRunStatus] = useState<RunStatusFilter>("all");
  const [runSource, setRunSource] = useState<RunSourceFilter>("all");
  const ws = useStore((s) => s.activeWorkspaceId);
  const requests = useWorkspaceAsyncCoordinator(ws, () => useStore.getState().activeWorkspaceId);

  const refresh = () => {
    const request = requests.beginLatest(ws);
    if (!request) return;
    setLoading(true);
    setError(null);
    Promise.allSettled([
      api.doctor(request.workspaceId),
      api.runs(request.workspaceId),
      api.orchestrationDiagnostics(request.workspaceId),
    ])
      .then(([reportResult, runsResult, operationsResult]) => {
        if (reportResult.status === "rejected") throw reportResult.reason;
        if (requests.isCurrent(request)) {
          setReport(reportResult.value);
          setRuns(runsResult.status === "fulfilled" ? runsResult.value : []);
          setOperations(operationsResult.status === "fulfilled" ? operationsResult.value : null);
        }
      })
      .catch((e: unknown) => {
        if (!requests.isCurrent(request)) return;
        // An older server predates /api/doctor — say so plainly instead of a
        // raw ApiError (it means the running server needs updating).
        setError(
          e instanceof ApiError && e.status === 404
            ? t("diagnostics.unsupported")
            : t("diagnostics.error", { error: String(e) }),
        );
      })
      .finally(() => {
        if (requests.isCurrent(request)) setLoading(false);
      });
  };

  useEffect(() => {
    setReport(null);
    setRuns([]);
    setOperations(null);
    setEvents({});
    setRunQuery("");
    setRunStatus("all");
    setRunSource("all");
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests]);

  useEffect(() => {
    if (!runs.some((run) => run.status === "queued" || run.status === "running" || run.status === "waiting")) return;
    const timer = window.setInterval(() => {
      const request = requests.capture(ws);
      if (!request) return;
      void api
        .runs(request.workspaceId)
        .then((nextRuns) => {
          if (requests.isCurrent(request)) setRuns(nextRuns);
        })
        .catch((cause: unknown) => {
          if (requests.isCurrent(request)) setError(t("diagnostics.error", { error: String(cause) }));
        });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [requests, runs, ws]);

  const checks = report ? toChecks(t, report) : [];
  const runSummary = useMemo(() => summarizeRuns(runs), [runs]);
  const visibleRuns = useMemo(
    () => filterRuns(runs, { query: runQuery, status: runStatus, source: runSource }),
    [runQuery, runSource, runStatus, runs],
  );
  const displayedRuns = useMemo(() => visibleRuns.slice(0, 50), [visibleRuns]);
  const visibleRunSummary = useMemo(() => summarizeRuns(displayedRuns), [displayedRuns]);

  const showEvents = (runId: string) => {
    const request = requests.capture(ws);
    if (!request) return;
    setError(null);
    void fetchRunEventTail((afterSeq) => api.runEvents(runId, afterSeq, request.workspaceId), 20, runId)
      .then((tail) => {
        if (requests.isCurrent(request)) setEvents((current) => ({ ...current, [runId]: tail }));
      })
      .catch((cause: unknown) => {
        if (requests.isCurrent(request)) setError(t("diagnostics.error", { error: String(cause) }));
      });
  };

  const cancelRun = (runId: string) => {
    const request = requests.capture(ws);
    if (!request) return;
    setError(null);
    void api
      .runCancel(runId, request.workspaceId)
      .then(() => {
        if (requests.isCurrent(request)) refresh();
      })
      .catch((cause: unknown) => {
        if (requests.isCurrent(request)) setError(t("diagnostics.error", { error: String(cause) }));
      });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-subtle px-6 py-4">
        <IconSettings className="text-tertiary" />
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-primary">{t("diagnostics.title")}</h1>
          <p className="mt-0.5 text-xs text-tertiary">{t("diagnostics.subtitle")}</p>
        </div>
        <Button size="sm" onClick={refresh} disabled={loading}>
          {t("diagnostics.refresh")}
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {error && (
          <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 p-2 text-xs text-danger">{error}</div>
        )}
        {report === null ? (
          !error && <p className="text-sm text-tertiary">{t("diagnostics.loading")}</p>
        ) : (
          <Card flush className="divide-y divide-subtle">
            {checks.map((c) => (
              <div key={c.label} className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-primary">{c.label}</div>
                  <div className="mt-0.5 break-words font-mono text-xs text-secondary">{c.value}</div>
                </div>
                <Badge tone={c.ok ? "ok" : "warn"}>{c.ok ? t("diagnostics.ok") : t("diagnostics.warn")}</Badge>
              </div>
            ))}
          </Card>
        )}

        <section className="mt-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t("diagnostics.runsTitle")}</h2>
            <Badge tone={runSummary.active > 0 ? "accent" : "neutral"}>
              {runSummary.active} {t("diagnostics.active")}
            </Badge>
          </div>
          <div className="mb-3 grid gap-2 sm:grid-cols-3">
            <Input
              value={runQuery}
              onChange={(event) => setRunQuery(event.target.value)}
              placeholder={t("diagnostics.runSearch")}
            />
            <select
              className="rounded border border-subtle bg-surface px-2 py-1 text-xs"
              value={runStatus}
              onChange={(event) => setRunStatus(event.target.value as RunStatusFilter)}
            >
              {["all", "queued", "running", "waiting", "succeeded", "failed", "cancelled"].map((status) => (
                <option key={status} value={status}>
                  {status === "all" ? t("diagnostics.allStatuses") : status}
                </option>
              ))}
            </select>
            <select
              className="rounded border border-subtle bg-surface px-2 py-1 text-xs"
              value={runSource}
              onChange={(event) => setRunSource(event.target.value as RunSourceFilter)}
            >
              {["all", "ws", "loop", "graph", "schedule", "trigger", "background"].map((source) => (
                <option key={source} value={source}>
                  {source === "all" ? t("diagnostics.allSources") : source}
                </option>
              ))}
            </select>
          </div>
          <p className="mb-3 text-xs text-tertiary">
            {t("diagnostics.runSummary", {
              count: displayedRuns.length,
              succeeded: visibleRunSummary.succeeded,
              failed: visibleRunSummary.failed,
              cost: visibleRunSummary.totalCostUsd.toFixed(4),
            })}
          </p>
          <div className="grid gap-3 lg:grid-cols-2">
            {displayedRuns.map((run) => (
              <Card key={run.runId} className="p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-primary">{run.runId}</span>
                  <Badge tone={run.status === "failed" ? "danger" : run.status === "succeeded" ? "ok" : "accent"}>
                    {run.status}
                  </Badge>
                </div>
                <p className="mt-1 text-tertiary">
                  {run.source} · {new Date(run.updatedAt).toLocaleString()} · ${(run.costUsd ?? 0).toFixed(4)}
                </p>
                {run.labels && (
                  <p className="mt-1 break-words text-tertiary">
                    {Object.entries(run.labels)
                      .map(([key, value]) => `${key}=${value}`)
                      .join(" · ")}
                  </p>
                )}
                {run.error && (
                  <p className="mt-1 text-danger">
                    {run.error.code}: {run.error.message}
                  </p>
                )}
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => showEvents(run.runId)}>
                    {t("diagnostics.events")}
                  </Button>
                  {(run.status === "queued" || run.status === "running" || run.status === "waiting") && (
                    <Button size="sm" variant="danger" onClick={() => cancelRun(run.runId)}>
                      {t("diagnostics.cancel")}
                    </Button>
                  )}
                </div>
                {events[run.runId] && (
                  <pre className="mt-2 max-h-40 overflow-auto rounded bg-surface-overlay p-2 text-[10px]">
                    {events[run.runId]!.map(
                      (event) => `${event.seq} ${event.ts} ${String(event.frame.type ?? "event")}`,
                    ).join("\n")}
                  </pre>
                )}
              </Card>
            ))}
            {visibleRuns.length === 0 && <p className="text-xs text-tertiary">{t("diagnostics.noRuns")}</p>}
          </div>
        </section>

        {operations && (
          <section className="mt-6">
            <h2 className="mb-2 text-sm font-semibold">{t("diagnostics.operationsTitle")}</h2>
            <Card className="p-4 text-xs text-secondary">
              <p>
                {operations.healthy ? t("diagnostics.healthy") : t("diagnostics.degraded")} · {operations.loops.length}{" "}
                loops · {operations.graphs.length} graphs · {operations.artifactStore.attestations} attestations
              </p>
              <p className="mt-1 text-tertiary">
                controller: {operations.controller.mode} · decisions {operations.decisions.length} · rollouts{" "}
                {operations.rollouts.length} · reservations {operations.reservations.length}
              </p>
            </Card>
          </section>
        )}
      </div>
    </div>
  );
}
