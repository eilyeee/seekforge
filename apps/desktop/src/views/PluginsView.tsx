import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { useStore } from "../store";
import type { PluginRecord, PluginStatus } from "../types";
import { Badge, Button, Card, EmptyState, IconPlugins, Input, type BadgeTone } from "../components/ui";
import { useWorkspaceAsyncCoordinator } from "./use-workspace-async";

const STATUS_TONE: Record<PluginStatus, BadgeTone> = {
  enabled: "ok",
  disabled: "neutral",
  changed: "warn",
  review_required: "accent",
  invalid: "danger",
};

export function PluginsView() {
  const t = useT();
  const ws = useStore((state) => state.activeWorkspaceId);
  const requests = useWorkspaceAsyncCoordinator(ws, () => useStore.getState().activeWorkspaceId);
  const [plugins, setPlugins] = useState<PluginRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newId, setNewId] = useState("");
  const [installPath, setInstallPath] = useState("");

  const refresh = (workspaceId = ws) => {
    const request = requests.beginLatest(workspaceId);
    if (!request) return;
    api
      .plugins(workspaceId)
      .then((records) => {
        if (requests.isCurrent(request)) setPlugins(records);
      })
      .catch((cause: unknown) => {
        if (requests.isCurrent(request)) setError(String(cause));
      });
  };

  useEffect(() => {
    setPlugins(null);
    setError(null);
    setBusy(null);
    refresh(ws);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests]);

  const mutate = (key: string, operation: (workspaceId: string) => Promise<unknown>) => {
    const request = requests.capture(ws);
    if (!request) return;
    setBusy(key);
    setError(null);
    operation(request.workspaceId)
      .then(() => {
        if (requests.isCurrent(request)) refresh(request.workspaceId);
      })
      .catch((cause: unknown) => {
        if (requests.isCurrent(request)) setError(String(cause));
      })
      .finally(() => {
        if (requests.isCurrent(request)) setBusy(null);
      });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-subtle px-6 py-4">
        <div className="flex items-center gap-2">
          <IconPlugins className="text-accent" />
          <h1 className="text-lg font-semibold">{t("plugins.title")}</h1>
        </div>
        <p className="mt-1 text-sm text-secondary">{t("plugins.description")}</p>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        {error && (
          <div className="mb-4 rounded border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</div>
        )}

        <div className="mb-5 grid gap-3 lg:grid-cols-2">
          <Card className="flex items-end gap-2 p-4">
            <label htmlFor="plugin-create-id" className="min-w-0 flex-1 text-xs text-secondary">
              {t("plugins.createLabel")}
              <Input
                id="plugin-create-id"
                value={newId}
                onChange={(event) => setNewId(event.target.value)}
                placeholder="my-plugin"
              />
            </label>
            <Button
              disabled={!newId.trim() || busy !== null}
              onClick={() =>
                mutate("create", async (workspaceId) => {
                  await api.pluginCreate(newId.trim(), workspaceId);
                  setNewId("");
                })
              }
            >
              {t("plugins.create")}
            </Button>
          </Card>
          <Card className="flex items-end gap-2 p-4">
            <label htmlFor="plugin-install-path" className="min-w-0 flex-1 text-xs text-secondary">
              {t("plugins.installLabel")}
              <Input
                id="plugin-install-path"
                value={installPath}
                onChange={(event) => setInstallPath(event.target.value)}
                placeholder="/path/to/plugin"
              />
            </label>
            <Button
              disabled={!installPath.trim() || busy !== null}
              onClick={() =>
                mutate("install", async (workspaceId) => {
                  await api.pluginInstall(installPath.trim(), false, workspaceId);
                  setInstallPath("");
                })
              }
            >
              {t("plugins.install")}
            </Button>
          </Card>
        </div>

        {plugins === null ? (
          <div className="py-12 text-center text-sm text-tertiary">{t("common.loading")}</div>
        ) : plugins.length === 0 ? (
          <EmptyState icon={<IconPlugins size={28} />} title={t("plugins.empty")} />
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {plugins.map((plugin) => (
              <Card key={`${plugin.scope}:${plugin.id}`} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-medium">{plugin.manifest?.name ?? plugin.id}</h2>
                      <Badge tone={STATUS_TONE[plugin.status]}>{plugin.status}</Badge>
                      <Badge tone="neutral">{plugin.scope}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-tertiary">
                      {plugin.id}@{plugin.manifest?.version ?? "-"}
                    </p>
                    {plugin.manifest?.description && (
                      <p className="mt-2 text-sm text-secondary">{plugin.manifest.description}</p>
                    )}
                    {plugin.manifest?.contributes && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {(plugin.manifest.contributes.skillRoots?.length ?? 0) > 0 && (
                          <Badge tone="neutral">
                            {t("plugins.skillsCount", { count: plugin.manifest.contributes.skillRoots!.length })}
                          </Badge>
                        )}
                        {(plugin.manifest.contributes.agentRoots?.length ?? 0) > 0 && (
                          <Badge tone="neutral">
                            {t("plugins.agentsCount", { count: plugin.manifest.contributes.agentRoots!.length })}
                          </Badge>
                        )}
                        {Object.keys(plugin.manifest.contributes.mcpServers ?? {}).length > 0 && (
                          <Badge tone="neutral">
                            {t("plugins.mcpCount", {
                              count: Object.keys(plugin.manifest.contributes.mcpServers ?? {}).length,
                            })}
                          </Badge>
                        )}
                        {Object.keys(plugin.manifest.contributes.hooks ?? {}).length > 0 && (
                          <Badge tone="warn">
                            {t("plugins.hooksCount", {
                              count: Object.keys(plugin.manifest.contributes.hooks ?? {}).length,
                            })}
                          </Badge>
                        )}
                      </div>
                    )}
                    {plugin.error && <p className="mt-2 text-xs text-danger">{plugin.error}</p>}
                    {plugin.digest && (
                      <p className="mt-2 font-mono text-[11px] text-tertiary" title={plugin.digest}>
                        sha256 {plugin.digest.slice(0, 16)}…
                      </p>
                    )}
                    <p className="mt-2 truncate font-mono text-[11px] text-tertiary" title={plugin.path}>
                      {plugin.path}
                    </p>
                    {plugin.manifest && (
                      <details className="mt-2 text-xs text-secondary">
                        <summary className="cursor-pointer">{t("plugins.inspectManifest")}</summary>
                        <pre className="mt-2 max-h-52 overflow-auto rounded bg-surface-overlay p-2 text-[11px]">
                          {JSON.stringify(plugin.manifest, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {plugin.scope === "project" && (
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      onClick={() =>
                        mutate(`install:${plugin.id}`, (workspaceId) =>
                          api.pluginInstall(plugin.path, false, workspaceId),
                        )
                      }
                    >
                      {t("plugins.reviewInstall")}
                    </Button>
                  )}
                  {plugin.scope === "global" && plugin.status !== "enabled" && plugin.status !== "invalid" && (
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      onClick={() =>
                        mutate(`enable:${plugin.id}`, (workspaceId) =>
                          api.pluginSetEnabled(plugin.id, true, workspaceId),
                        )
                      }
                    >
                      {plugin.status === "changed" ? t("plugins.reapprove") : t("plugins.enable")}
                    </Button>
                  )}
                  {plugin.scope === "global" && plugin.status === "enabled" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() =>
                        mutate(`disable:${plugin.id}`, (workspaceId) =>
                          api.pluginSetEnabled(plugin.id, false, workspaceId),
                        )
                      }
                    >
                      {t("plugins.disable")}
                    </Button>
                  )}
                  {plugin.scope === "global" && (
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busy !== null}
                      onClick={() => {
                        if (window.confirm(t("plugins.removeConfirm", { id: plugin.id }))) {
                          mutate(`remove:${plugin.id}`, (workspaceId) => api.pluginDelete(plugin.id, workspaceId));
                        }
                      }}
                    >
                      {t("plugins.remove")}
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
