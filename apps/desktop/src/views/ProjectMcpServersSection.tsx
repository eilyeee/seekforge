import { useState } from "react";
import { ApiError, api } from "../lib/api";
import { useT } from "../lib/i18n";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Badge, Button, Card, type BadgeTone } from "../components/ui";
import type { ProjectMcpServer, ProjectMcpServerStatus } from "../types";
import type { WorkspaceAsyncCoordinator } from "./async-coordination";

const STATUS_TONE: Record<ProjectMcpServerStatus, BadgeTone> = {
  pending: "warn",
  approved: "ok",
  rejected: "neutral",
};

type Decision = "approve" | "reject";

/**
 * Servers this checkout defines (.seekforge/config.json, config.local.json,
 * .mcp.json). None of them connects until the user approves that exact
 * definition for this workspace; the decision is keyed by a digest, so an
 * edited definition is pending again. The list never starts anything.
 */
export function ProjectMcpServersSection({
  ws,
  servers,
  loadError,
  coordinator,
  onUpdated,
  onReload,
}: {
  ws: string;
  /** null while loading. */
  servers: ProjectMcpServer[] | null;
  loadError: string | null;
  coordinator: WorkspaceAsyncCoordinator<string>;
  onUpdated: (server: ProjectMcpServer) => void;
  onReload: () => void;
}) {
  const t = useT();
  const [confirm, setConfirm] = useState<ProjectMcpServer | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "warn" | "danger"; text: string } | null>(null);

  const decide = (server: ProjectMcpServer, decision: Decision) => {
    const operation = coordinator.capture(ws);
    if (!operation) return;
    setBusy(server.name);
    setNotice(null);
    api
      .mcpProjectServerDecide(server.name, decision, server.digest, operation.workspaceId)
      .then((updated) => {
        if (coordinator.isCurrent(operation)) onUpdated(updated);
      })
      .catch((error: unknown) => {
        if (!coordinator.isCurrent(operation)) return;
        if (error instanceof ApiError && error.status === 409) {
          // The file changed after it was shown: never decide on a definition
          // the user did not see. Reload and ask for a fresh review.
          setNotice({ tone: "warn", text: t("settings.mcpProjectChanged", { name: server.name }) });
          onReload();
          return;
        }
        setNotice({ tone: "danger", text: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        if (coordinator.isCurrent(operation)) setBusy(null);
      });
  };

  return (
    <div className="mt-4">
      <h3 className="mb-1 px-1 text-2xs uppercase tracking-wider text-tertiary">{t("settings.mcpProjectTitle")}</h3>
      <p className="mb-2 px-1 text-2xs text-tertiary">{t("settings.mcpProjectHint")}</p>
      {notice && (
        <div
          className={`mb-2 rounded-lg border p-2 text-xs ${
            notice.tone === "warn" ? "border-warn/40 bg-warn/10 text-warn" : "border-danger/40 bg-danger/10 text-danger"
          }`}
        >
          {notice.text}
        </div>
      )}
      {loadError ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 p-2 text-xs text-danger">{loadError}</div>
      ) : servers === null ? (
        <p className="px-1 text-sm text-tertiary">{t("settings.loading")}</p>
      ) : servers.length === 0 ? (
        <p className="px-1 text-sm text-tertiary">{t("settings.mcpProjectEmpty")}</p>
      ) : (
        <div className="space-y-2">
          {servers.map((server) => (
            <Card key={server.name} className="p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm text-primary">{server.name}</span>
                <Badge tone={STATUS_TONE[server.status]}>{t(`settings.mcpProjectStatus.${server.status}`)}</Badge>
                <Badge tone={server.transport === "invalid" ? "danger" : "neutral"}>{server.transport}</Badge>
                <div className="ml-auto flex gap-1.5">
                  {server.status !== "approved" && (
                    <Button size="sm" disabled={busy !== null} onClick={() => setConfirm(server)}>
                      {t("settings.mcpProjectApprove")}
                    </Button>
                  )}
                  {server.status !== "rejected" && (
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => decide(server, "reject")}>
                      {t("settings.mcpProjectReject")}
                    </Button>
                  )}
                </div>
              </div>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-overlay p-2 font-mono text-[11px] text-secondary">
                {server.definition}
              </pre>
            </Card>
          ))}
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={t("settings.mcpProjectApproveTitle", { name: confirm.name })}
          confirmLabel={t("settings.mcpProjectApprove")}
          danger
          onConfirm={() => {
            const server = confirm;
            setConfirm(null);
            decide(server, "approve");
          }}
          onCancel={() => setConfirm(null)}
        >
          <p>{t("settings.mcpProjectApproveBody")}</p>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-overlay p-2 font-mono text-[11px] text-primary">
            {confirm.definition}
          </pre>
        </ConfirmDialog>
      )}
    </div>
  );
}
