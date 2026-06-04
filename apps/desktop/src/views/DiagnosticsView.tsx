import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { useT } from "../lib/i18n";
import { Badge, Button, Card, IconSettings } from "../components/ui";
import type { DoctorReport } from "../types";

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
      value:
        r.modelCount > 0
          ? t("diagnostics.modelsCount", { count: r.modelCount })
          : t("diagnostics.modelsNone"),
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
  const ws = useStore((s) => s.activeWorkspaceId);

  const refresh = () => {
    setLoading(true);
    setError(null);
    api
      .doctor()
      .then(setReport)
      .catch((e: unknown) => setError(t("diagnostics.error", { error: String(e) })))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    setReport(null);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  const checks = report ? toChecks(t, report) : [];

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
          <Card flush className="max-w-2xl divide-y divide-subtle">
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
      </div>
    </div>
  );
}
