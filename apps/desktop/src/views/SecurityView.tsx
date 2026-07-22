import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { useStore } from "../store";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Badge, Button, Card, EmptyState, IconShield, Input, Select, TextArea, type BadgeTone } from "../components/ui";
import type { FindingStatus, SecurityEvidencePackage, SecurityFinding } from "../types";
import { useWorkspaceAsyncCoordinator } from "./use-workspace-async";

type Section = "findings" | "threats" | "reports";
type BusyAction = "scan" | "threat" | "export" | "status" | "fix" | null;

const SEVERITY_TONE: Record<SecurityFinding["severity"], BadgeTone> = {
  critical: "danger",
  high: "danger",
  medium: "warn",
  low: "accent",
  info: "neutral",
};

const FINDING_STATUS_OPTIONS: FindingStatus[] = [
  "open",
  "triaged",
  "resolved",
  "accepted_risk",
  "dismissed",
  "reopened",
];

function downloadReport(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function SecurityView() {
  const t = useT();
  const ws = useStore((state) => state.activeWorkspaceId);
  const [data, setData] = useState<SecurityEvidencePackage | null>(null);
  const [section, setSection] = useState<Section>("findings");
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SecurityFinding | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [fixOpen, setFixOpen] = useState(false);
  const requests = useWorkspaceAsyncCoordinator(ws, () => useStore.getState().activeWorkspaceId);

  const refresh = async (workspaceId = ws): Promise<boolean> => {
    const request = requests.beginLatest(workspaceId);
    if (!request) return false;
    try {
      const result = await api.security(workspaceId);
      if (!requests.isCurrent(request)) return false;
      setData(result);
      setError(null);
      return true;
    } catch (reason) {
      if (requests.isCurrent(request)) setError(String(reason));
      return false;
    }
  };

  useEffect(() => {
    setData(null);
    setError(null);
    setSelected(null);
    setBusy(null);
    setStatusOpen(false);
    setFixOpen(false);
    void refresh(ws);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests]);

  const counts = useMemo(() => {
    const findings = data?.findings ?? [];
    return {
      active: findings.filter((finding) => !["resolved", "accepted_risk", "dismissed"].includes(finding.status)).length,
      critical: findings.filter((finding) => finding.severity === "critical" || finding.severity === "high").length,
      verified: findings.filter((finding) => finding.verificationStatus === "verified").length,
    };
  }, [data]);

  async function run<Result>(
    action: Exclude<BusyAction, null>,
    operation: (workspaceId: string) => Promise<Result>,
    onSuccess?: (result: Result) => void,
  ): Promise<boolean> {
    const owner = requests.capture(ws);
    if (!owner) return false;
    setBusy(action);
    setError(null);
    try {
      const result = await operation(owner.workspaceId);
      if (!requests.isCurrent(owner)) return false;
      onSuccess?.(result);
      await refresh(owner.workspaceId);
      return requests.isCurrent(owner);
    } catch (reason) {
      if (requests.isCurrent(owner)) setError(String(reason));
      return false;
    } finally {
      if (requests.isCurrent(owner)) setBusy(null);
    }
  }

  const exportReport = (format: "json" | "markdown" | "sarif") =>
    run(
      "export",
      (workspaceId) => api.securityExport(format, workspaceId),
      (report) => downloadReport(report.filename, report.content),
    );

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="border-b border-subtle px-6 py-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
            <h1 className="text-lg font-semibold text-primary">{t("security.title")}</h1>
            <p className="mt-1 text-xs text-tertiary">{t("security.subtitle")}</p>
          </div>
          <Button
            disabled={busy !== null}
            onClick={() => void run("threat", (workspaceId) => api.securityThreatModel(workspaceId))}
          >
            {busy === "threat" ? t("security.running") : t("security.threatModel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy !== null}
            onClick={() => void run("scan", (workspaceId) => api.securityScan(50, workspaceId))}
          >
            <IconShield size={14} />
            {busy === "scan" ? t("security.running") : t("security.scan")}
          </Button>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-4 border-t border-subtle pt-3">
          <div>
            <div className="font-mono text-lg text-primary">{counts.active}</div>
            <div className="text-2xs uppercase tracking-wider text-tertiary">{t("security.active")}</div>
          </div>
          <div>
            <div className="font-mono text-lg text-danger">{counts.critical}</div>
            <div className="text-2xs uppercase tracking-wider text-tertiary">{t("security.highRisk")}</div>
          </div>
          <div>
            <div className="font-mono text-lg text-ok">{counts.verified}</div>
            <div className="text-2xs uppercase tracking-wider text-tertiary">{t("security.verified")}</div>
          </div>
        </div>
        <div className="mt-4 flex gap-1 border-b border-subtle">
          {(["findings", "threats", "reports"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setSection(value)}
              className={`border-b-2 px-3 py-2 text-xs ${section === value ? "border-accent text-accent" : "border-transparent text-tertiary hover:text-secondary"}`}
            >
              {t(`security.tab.${value}`)}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {error && <div className="mb-4 border border-danger/40 bg-danger/10 p-3 text-xs text-danger">{error}</div>}
        {!data ? (
          !error && <p className="text-sm text-tertiary">{t("common.loading")}</p>
        ) : section === "findings" ? (
          data.findings.length === 0 ? (
            <EmptyState
              icon={<IconShield size={28} />}
              title={t("security.emptyTitle")}
              description={t("security.emptyDescription")}
            />
          ) : (
            <div className="space-y-3">
              {data.findings.map((finding) => (
                <Card key={finding.id} className="p-4">
                  <div className="flex flex-wrap items-start gap-2">
                    <button
                      type="button"
                      onClick={() => setSelected(selected?.id === finding.id ? null : finding)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-primary">{finding.title}</span>
                        <Badge tone={SEVERITY_TONE[finding.severity]}>{finding.severity}</Badge>
                        <Badge tone="neutral">{finding.status}</Badge>
                        <Badge
                          tone={
                            finding.verificationStatus === "verified"
                              ? "ok"
                              : finding.verificationStatus === "failed"
                                ? "danger"
                                : "neutral"
                          }
                        >
                          {finding.verificationStatus}
                        </Badge>
                      </div>
                      <div className="mt-1 font-mono text-2xs text-tertiary">
                        {finding.id} · {finding.source.ruleId}
                      </div>
                    </button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setSelected(finding);
                        setStatusOpen(true);
                      }}
                    >
                      {t("security.changeStatus")}
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={finding.status === "fixing" || busy !== null}
                      onClick={() => {
                        setSelected(finding);
                        setFixOpen(true);
                      }}
                    >
                      {t("security.autoFix")}
                    </Button>
                  </div>
                  {selected?.id === finding.id && (
                    <div className="mt-3 border-t border-subtle pt-3 text-xs text-secondary">
                      <p className="whitespace-pre-wrap">{finding.description}</p>
                      <div className="mt-3 space-y-2">
                        {finding.evidence.map((evidence, index) => (
                          <div key={`${evidence.path}:${index}`} className="border-l-2 border-strong pl-3">
                            <div className="font-mono text-accent">
                              {evidence.path}:{evidence.lineStart}-{evidence.lineEnd}
                            </div>
                            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-2xs text-tertiary">
                              {evidence.excerpt}
                            </pre>
                          </div>
                        ))}
                      </div>
                      <p className="mt-3">
                        <span className="font-medium text-primary">{t("security.recommendation")}:</span>{" "}
                        {finding.recommendation}
                      </p>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )
        ) : section === "threats" ? (
          data.threatModels.length === 0 ? (
            <EmptyState
              icon={<IconShield size={28} />}
              title={t("security.noThreatModel")}
              description={t("security.noThreatModelDescription")}
            />
          ) : (
            <div className="space-y-5">
              {[...data.threatModels].reverse().map((model) => (
                <section key={model.id}>
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold text-primary">{model.repository}</h2>
                    <span className="font-mono text-2xs text-tertiary">{model.createdAt}</span>
                  </div>
                  <p className="mt-2 text-sm text-secondary">{model.summary}</p>
                  <div className="mt-3 grid gap-3 lg:grid-cols-2">
                    {model.threats.map((threat) => (
                      <Card key={threat.id} className="p-4">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-primary">{threat.title}</span>
                          <Badge tone={SEVERITY_TONE[threat.severity]}>{threat.severity}</Badge>
                        </div>
                        <p className="mt-2 text-xs text-secondary">{threat.scenario}</p>
                        <p className="mt-2 font-mono text-2xs text-tertiary">
                          {threat.evidence.map((item) => `${item.path}:${item.lineStart}`).join(" · ")}
                        </p>
                      </Card>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )
        ) : (
          <div className="max-w-3xl">
            <h2 className="text-sm font-semibold text-primary">{t("security.evidenceReports")}</h2>
            <p className="mt-1 text-xs text-tertiary">{data.disclaimer}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button disabled={busy !== null} onClick={() => void exportReport("json")}>
                JSON
              </Button>
              <Button disabled={busy !== null} onClick={() => void exportReport("markdown")}>
                Markdown
              </Button>
              <Button disabled={busy !== null} onClick={() => void exportReport("sarif")}>
                SARIF 2.1.0
              </Button>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-x-8 gap-y-4 border-t border-subtle pt-4 text-xs">
              <div>
                <span className="text-tertiary">{t("security.scans")}</span>
                <div className="mt-1 font-mono text-primary">{data.scans.length}</div>
              </div>
              <div>
                <span className="text-tertiary">{t("security.fixAttempts")}</span>
                <div className="mt-1 font-mono text-primary">{data.fixes.length}</div>
              </div>
              <div>
                <span className="text-tertiary">{t("security.findings")}</span>
                <div className="mt-1 font-mono text-primary">{data.findings.length}</div>
              </div>
              <div>
                <span className="text-tertiary">{t("security.threatModels")}</span>
                <div className="mt-1 font-mono text-primary">{data.threatModels.length}</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {selected && statusOpen && (
        <FindingStatusDialog
          finding={selected}
          busy={busy === "status"}
          onClose={() => setStatusOpen(false)}
          onSubmit={(status, reason) =>
            void run("status", (workspaceId) =>
              api.securityFindingStatus(selected.id, status, reason, workspaceId),
            ).then((ok) => {
              if (ok) setStatusOpen(false);
            })
          }
        />
      )}
      {selected && fixOpen && (
        <FindingFixDialog
          finding={selected}
          busy={busy === "fix"}
          onClose={() => setFixOpen(false)}
          onSubmit={(maxCost, verify, lint) =>
            void run("fix", (workspaceId) => api.securityFix(selected.id, maxCost, verify, lint, workspaceId)).then(
              (ok) => {
                if (ok) setFixOpen(false);
              },
            )
          }
        />
      )}
    </div>
  );
}

function FindingStatusDialog({
  finding,
  busy,
  onClose,
  onSubmit,
}: {
  finding: SecurityFinding;
  busy: boolean;
  onClose: () => void;
  onSubmit: (status: FindingStatus, reason: string) => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<FindingStatus>(finding.status === "fixing" ? "reopened" : finding.status);
  const [reason, setReason] = useState("");
  return (
    <ConfirmDialog
      title={t("security.statusTitle")}
      confirmLabel={busy ? t("security.running") : t("action.confirm")}
      confirmDisabled={busy || status === finding.status}
      onConfirm={() => onSubmit(status, reason)}
      onCancel={onClose}
    >
      <div className="space-y-3">
        <Select
          value={status}
          onChange={(value) => setStatus(value as FindingStatus)}
          options={FINDING_STATUS_OPTIONS.map((value) => ({ value, label: value }))}
          className="w-full"
        />
        <TextArea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          placeholder={t("security.statusReason")}
        />
      </div>
    </ConfirmDialog>
  );
}

function FindingFixDialog({
  finding,
  busy,
  onClose,
  onSubmit,
}: {
  finding: SecurityFinding;
  busy: boolean;
  onClose: () => void;
  onSubmit: (maxCostUsd: number, verify: string, lint?: string) => void;
}) {
  const t = useT();
  const [maxCost, setMaxCost] = useState("1");
  const [verify, setVerify] = useState("pnpm test");
  const [lint, setLint] = useState("pnpm typecheck");
  const parsedMaxCost = Number(maxCost);
  return (
    <ConfirmDialog
      title={t("security.fixTitle", { id: finding.id })}
      confirmLabel={busy ? t("security.running") : t("security.autoFix")}
      confirmDisabled={busy || !verify.trim() || !Number.isFinite(parsedMaxCost) || parsedMaxCost <= 0}
      onConfirm={() => onSubmit(parsedMaxCost, verify.trim(), lint.trim() || undefined)}
      onCancel={onClose}
    >
      <div className="space-y-3">
        <p className="text-xs text-secondary">{t("security.fixWarning")}</p>
        <label htmlFor="security-fix-max-cost" className="block">
          <span className="text-2xs uppercase tracking-wider text-tertiary">{t("security.maxCost")}</span>
          <Input
            id="security-fix-max-cost"
            type="number"
            min="0.01"
            step="0.01"
            value={maxCost}
            onChange={(event) => setMaxCost(event.target.value)}
            className="mt-1 font-mono"
          />
        </label>
        <label htmlFor="security-fix-verify" className="block">
          <span className="text-2xs uppercase tracking-wider text-tertiary">{t("security.verifyCommand")}</span>
          <Input
            id="security-fix-verify"
            value={verify}
            onChange={(event) => setVerify(event.target.value)}
            className="mt-1 font-mono"
          />
        </label>
        <label htmlFor="security-fix-lint" className="block">
          <span className="text-2xs uppercase tracking-wider text-tertiary">{t("security.lintCommand")}</span>
          <Input
            id="security-fix-lint"
            value={lint}
            onChange={(event) => setLint(event.target.value)}
            className="mt-1 font-mono"
          />
        </label>
      </div>
    </ConfirmDialog>
  );
}
