import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import type { WorkspaceOperationalDiagnostics } from "../../types";
import { Badge, Button } from "../ui";

export function OperationalDiagnosticsSection(props: { workspaceId?: string }) {
  const t = useT();
  const generation = useRef(0);
  const [report, setReport] = useState<WorkspaceOperationalDiagnostics>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    const request = ++generation.current;
    setBusy(true);
    try {
      const next = await api.orchestrationDiagnostics(props.workspaceId);
      if (generation.current === request) {
        setReport(next);
        setError("");
      }
    } catch (caught) {
      if (generation.current === request) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (generation.current === request) setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [props.workspaceId]);

  const reconcile = async (orphanReservationIds: string[] = []) => {
    if (
      orphanReservationIds.length > 0 &&
      !window.confirm(t("chat.loop.diagnostics.removeReservationConfirm", { id: orphanReservationIds[0]! }))
    )
      return;
    const request = ++generation.current;
    setBusy(true);
    try {
      await api.orchestrationReconcileCapacity(orphanReservationIds, props.workspaceId);
      if (generation.current === request) await refresh();
    } catch (caught) {
      if (generation.current === request) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (generation.current === request) setBusy(false);
    }
  };

  const exportReport = () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `seekforge-diagnostics-${report.generatedAt.replace(/[:.]/g, "-")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const diagnostics = [...(report?.loops ?? []), ...(report?.graphs ?? [])];
  return (
    <details className="mt-3 rounded border border-subtle p-2 text-xs text-secondary">
      <summary className="cursor-pointer font-medium">{t("chat.loop.diagnostics.title")}</summary>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {report && <Badge tone={report.healthy ? "ok" : "danger"}>{report.healthy ? "healthy" : "attention"}</Badge>}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
          {t("chat.loop.diagnostics.refresh")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void reconcile([])}>
          {t("chat.loop.diagnostics.reconcile")}
        </Button>
        <Button size="sm" variant="ghost" disabled={!report} onClick={exportReport}>
          {t("chat.loop.diagnostics.export")}
        </Button>
      </div>
      {error && <p className="mt-2 text-danger">{error}</p>}
      {report && (
        <>
          <p className="mt-2 text-tertiary">
            {t("chat.loop.diagnostics.controller")}: {report.controller.mode} · {report.decisions.length}{" "}
            {t("chat.loop.orchestration.decisions")} · {report.rollouts.length} {t("chat.loop.orchestration.rollouts")}
          </p>
          <p className="mt-1 text-tertiary">
            {t("chat.loop.diagnostics.capacity")}: {report.reservations.length} · CAS {report.artifactStore.blobs} blobs
            / {report.artifactStore.bytes.toLocaleString()} bytes / {report.artifactStore.attestations}{" "}
            {t("chat.loop.orchestration.attestations")}
          </p>
          {report.reservations.length > 0 && (
            <div className="mt-2 space-y-1">
              {report.reservations.map((reservation) => (
                <div key={reservation.reservationId} className="flex flex-wrap items-center gap-1">
                  <span>{reservation.executor}</span>
                  <span className="break-all text-tertiary">{reservation.reservationId}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void reconcile([reservation.reservationId])}
                  >
                    {t("chat.loop.diagnostics.removeOrphan")}
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 space-y-1">
            {diagnostics
              .filter((item) => !item.healthy)
              .map((item) => (
                <details key={`${item.kind}-${item.id}`} className="rounded border border-subtle p-1">
                  <summary className="cursor-pointer">
                    <Badge tone="danger">{item.kind}</Badge> {item.id} · {item.issues.length}{" "}
                    {t("chat.loop.diagnostics.issues")}
                  </summary>
                  {item.issues.map((issue, index) => (
                    <p key={`${issue.code}-${issue.sequence ?? index}`} className="mt-1 break-words text-tertiary">
                      {issue.severity}/{issue.code}: {issue.message}
                    </p>
                  ))}
                </details>
              ))}
          </div>
        </>
      )}
    </details>
  );
}
