import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { useT, useLocale, setLocale, type Locale } from "../lib/i18n";
import { notificationsEnabled, setNotificationsEnabled } from "../lib/notify";
import { useStore } from "../store";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Badge, Button, Card, IconSettings, Input, Select, TextArea } from "../components/ui";
import type { ConfigKey, McpPrompt, McpResource, McpServer, McpTool, ServerConfig } from "../types";

type SaveState = "idle" | "saving" | "saved" | "error";

function useFieldSave() {
  const [states, setStates] = useState<Partial<Record<ConfigKey, SaveState>>>({});
  const save = async (key: ConfigKey, value: string, global: boolean): Promise<ServerConfig | null> => {
    setStates((s) => ({ ...s, [key]: "saving" }));
    try {
      const config = await api.setConfig(key, value, global || undefined);
      setStates((s) => ({ ...s, [key]: "saved" }));
      setTimeout(() => setStates((s) => ({ ...s, [key]: "idle" })), 2000);
      return config;
    } catch {
      setStates((s) => ({ ...s, [key]: "error" }));
      return null;
    }
  };
  return { states, save };
}

function SaveButton({ state, onClick }: { state: SaveState; onClick: () => void }) {
  const t = useT();
  return (
    <Button variant="ghost" size="md" onClick={onClick} disabled={state === "saving"} className="shrink-0">
      {state === "saving" ? t("settings.saveSaving") : state === "saved" ? t("settings.saveSaved") : state === "error" ? t("settings.saveFailed") : t("settings.saveBtn")}
    </Button>
  );
}

/** A card wrapping a related group of settings under a small uppercase header. */
function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 px-1 text-2xs uppercase tracking-wider text-tertiary">{title}</h2>
      <Card flush className="divide-y divide-subtle">{children}</Card>
    </section>
  );
}

/**
 * One settings row: a left-hand label + optional description, and a right-hand
 * control. Stacks the control under the label on narrow widths.
 */
function SettingsRow({
  label,
  description,
  children,
  stacked = false,
}: {
  label: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Place the control full-width under the label (for multi-line inputs). */
  stacked?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-2 p-4 ${
        stacked ? "" : "sm:flex-row sm:items-start sm:justify-between sm:gap-6"
      }`}
    >
      <div className="min-w-0 sm:pt-1.5">
        <div className="text-sm font-medium text-primary">{label}</div>
        {description && <p className="mt-0.5 text-2xs text-tertiary">{description}</p>}
      </div>
      <div
        className={`flex w-full shrink-0 gap-2 ${
          stacked ? "" : "sm:w-auto sm:max-w-md sm:flex-1 sm:justify-end"
        }`}
      >
        {children}
      </div>
    </div>
  );
}

/** MCP servers list + on-demand tool listing (POST /api/mcp/:name/tools),
 * with an add form (stdio command/args OR url) and per-server remove. */
function McpSection() {
  const t = useT();
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Per server: tool list, an error string, or "loading". */
  const [tools, setTools] = useState<Record<string, McpTool[] | { error: string } | "loading">>({});
  const [addOpen, setAddOpen] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const ws = useStore((s) => s.activeWorkspaceId);

  const refresh = () =>
    api
      .mcp()
      .then(setServers)
      .catch((e: unknown) => setLoadError(String(e)));

  useEffect(() => {
    setServers(null);
    setLoadError(null);
    setTools({});
    setAddOpen(false);
    setPendingRemove(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  const listTools = (name: string) => {
    setTools((t) => ({ ...t, [name]: "loading" }));
    api
      .mcpTools(name)
      .then((list) => setTools((t) => ({ ...t, [name]: list })))
      .catch((e: unknown) => setTools((t) => ({ ...t, [name]: { error: String(e) } })));
  };

  const confirmRemove = () => {
    if (!pendingRemove) return;
    const name = pendingRemove;
    setPendingRemove(null);
    api
      .mcpRemove(name)
      .then(refresh)
      .catch((e: unknown) => setLoadError(String(e)));
  };

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <h2 className="text-2xs uppercase tracking-wider text-tertiary">{t("settings.mcpServers")}</h2>
        <Button variant="ghost" size="sm" onClick={() => setAddOpen(true)}>
          {t("settings.mcpAddBtn")}
        </Button>
      </div>
      {loadError && (
        <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 p-2 text-xs text-danger">{loadError}</div>
      )}
      {servers === null ? (
        !loadError && <p className="px-1 text-sm text-tertiary">{t("settings.loading")}</p>
      ) : servers.length === 0 ? (
        <p className="px-1 text-sm text-tertiary">{t("settings.mcpEmpty")}</p>
      ) : (
        <div className="space-y-3">
          {servers.map((srv) => {
            const state = tools[srv.name];
            return (
              <Card key={srv.name} className="p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-primary">{srv.name}</span>
                  <Badge tone={srv.trusted ? "ok" : "neutral"}>{t(srv.trusted ? "settings.mcpTrusted" : "settings.mcpUntrusted")}</Badge>
                  {srv.envKeys !== undefined && <Badge tone="neutral">{t("settings.mcpEnv", { count: srv.envKeys.length })}</Badge>}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    disabled={state === "loading"}
                    onClick={() => listTools(srv.name)}
                  >
                    {state === "loading" ? t("settings.mcpListing") : t("settings.mcpListTools")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-tertiary hover:text-danger"
                    onClick={() => setPendingRemove(srv.name)}
                  >
                    {t("settings.mcpRemoveBtn")}
                  </Button>
                </div>
                <div className="mt-1.5 font-mono text-xs text-tertiary">
                  {srv.command} {srv.args.join(" ")}
                </div>
                {state !== undefined && state !== "loading" && (
                  <div className="mt-2 border-t border-subtle pt-2">
                    {Array.isArray(state) ? (
                      <ul className="space-y-1">
                        {state.map((tool) => (
                          <li key={tool.name} className="text-xs">
                            <span className="font-mono text-accent">{tool.name}</span>
                            <span className="ml-2 text-secondary">{tool.description}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="font-mono text-xs text-danger">{state.error}</p>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
      {servers !== null && servers.length > 0 && (
        <>
          <McpResourcesSection ws={ws} />
          <McpPromptsSection ws={ws} />
        </>
      )}

      {addOpen && (
        <AddMcpDialog
          onClose={() => setAddOpen(false)}
          onAdded={() => {
            setAddOpen(false);
            void refresh();
          }}
        />
      )}
      {pendingRemove && (
        <ConfirmDialog
          title={t("settings.mcpRemoveTitle", { name: pendingRemove })}
          confirmLabel={t("settings.mcpRemoveConfirm")}
          danger
          onConfirm={confirmRemove}
          onCancel={() => setPendingRemove(null)}
        >
          {t("settings.mcpRemoveBody")}
        </ConfirmDialog>
      )}
    </section>
  );
}

/** Add-MCP form: name + a stdio transport (command/args) OR an http url. */
function AddMcpDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    name.trim() !== "" && (transport === "stdio" ? command.trim() !== "" : url.trim() !== "");

  const submit = () => {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    const cfg =
      transport === "stdio"
        ? {
            name: name.trim(),
            command: command.trim(),
            args: args.trim() === "" ? [] : args.trim().split(/\s+/),
            trusted,
          }
        : { name: name.trim(), url: url.trim(), trusted };
    api
      .mcpAdd(cfg)
      .then(onAdded)
      .catch((e: unknown) => {
        setError(t("settings.mcpAddError", { error: String(e) }));
        setBusy(false);
      });
  };

  return (
    <ConfirmDialog
      title={t("settings.mcpAddTitle")}
      confirmLabel={busy ? "…" : t("settings.mcpAddConfirm")}
      onConfirm={submit}
      onCancel={onClose}
    >
      <div className="space-y-3 text-xs">
        <label className="block">
          <span className="text-2xs uppercase tracking-wider text-tertiary">{t("settings.mcpAddName")}</span>
          <Input
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder={t("settings.mcpAddNamePlaceholder")}
            className="mt-1 font-mono"
            disabled={busy}
          />
        </label>
        <label className="block">
          <span className="text-2xs uppercase tracking-wider text-tertiary">{t("settings.mcpAddTransport")}</span>
          <Select
            value={transport}
            onChange={(v) => setTransport(v as "stdio" | "http")}
            disabled={busy}
            className="mt-1 w-full"
            options={[
              { value: "stdio", label: t("settings.mcpAddStdio") },
              { value: "http", label: t("settings.mcpAddHttp") },
            ]}
          />
        </label>
        {transport === "stdio" ? (
          <>
            <label className="block">
              <span className="text-2xs uppercase tracking-wider text-tertiary">{t("settings.mcpAddCommand")}</span>
              <Input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={t("settings.mcpAddCommandPlaceholder")}
                className="mt-1 font-mono"
                disabled={busy}
              />
            </label>
            <label className="block">
              <span className="text-2xs uppercase tracking-wider text-tertiary">{t("settings.mcpAddArgs")}</span>
              <Input
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder={t("settings.mcpAddArgsPlaceholder")}
                className="mt-1 font-mono"
                disabled={busy}
              />
            </label>
          </>
        ) : (
          <label className="block">
            <span className="text-2xs uppercase tracking-wider text-tertiary">{t("settings.mcpAddUrl")}</span>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("settings.mcpAddUrlPlaceholder")}
              className="mt-1 font-mono"
              disabled={busy}
            />
          </label>
        )}
        <label className="flex items-center gap-2 text-secondary">
          <input
            type="checkbox"
            checked={trusted}
            onChange={(e) => setTrusted(e.target.checked)}
            className="accent-accent"
            disabled={busy}
          />
          {t("settings.mcpAddTrusted")}
        </label>
        {error && <p className="text-danger">{error}</p>}
      </div>
    </ConfirmDialog>
  );
}

/**
 * Resources of every configured MCP server (GET /api/mcp/resources, spawned
 * on demand). Each row has a copy button for the @mcp:<server>:<uri> inline
 * reference syntax (paste it into a task to pull the resource in).
 */
function McpResourcesSection({ ws }: { ws: string }) {
  const t = useT();
  const [state, setState] = useState<McpResource[] | { error: string } | "loading" | null>(null);
  const [copiedUri, setCopiedUri] = useState<string | null>(null);

  const load = () => {
    setState("loading");
    api
      .mcpResources(ws)
      .then((r) => setState(r.resources))
      .catch((e: unknown) => setState({ error: String(e) }));
  };

  const copy = (server: string, uri: string) => {
    const ref = `@mcp:${server}:${uri}`;
    void navigator.clipboard.writeText(ref).then(() => {
      setCopiedUri(`${server}:${uri}`);
      setTimeout(() => setCopiedUri(null), 2000);
    });
  };

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 px-1">
        <h3 className="text-2xs uppercase tracking-wider text-tertiary">{t("settings.mcpResources")}</h3>
        <Button variant="ghost" size="sm" disabled={state === "loading"} onClick={load}>
          {state === "loading" ? t("settings.mcpListing") : state === null ? t("settings.mcpListResources") : t("settings.mcpRefresh")}
        </Button>
      </div>
      {state !== null && state !== "loading" && (
        <div className="mt-2">
          {Array.isArray(state) ? (
            state.length === 0 ? (
              <p className="px-1 text-xs text-tertiary">{t("settings.mcpResourcesEmpty")}</p>
            ) : (
              <ul className="space-y-1">
                {state.map((r) => (
                  <li
                    key={`${r.server}:${r.uri}`}
                    className="flex items-center gap-2 rounded-lg border border-subtle bg-surface-raised px-2 py-1 text-xs"
                  >
                    <span className="font-mono text-accent">{r.server}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-secondary" title={r.uri}>
                      {r.name ? `${r.name} — ${r.uri}` : r.uri}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      onClick={() => copy(r.server, r.uri)}
                      title={`copy @mcp:${r.server}:${r.uri}`}
                    >
                      {copiedUri === `${r.server}:${r.uri}` ? t("settings.mcpCopied") : t("settings.mcpCopyBtn")}
                    </Button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <p className="font-mono text-xs text-danger">{state.error}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Lists MCP prompts and expands one into the chat composer. */
function McpPromptsSection({ ws }: { ws: string }) {
  const t = useT();
  const composeInChat = useStore((s) => s.composeInChat);
  const [state, setState] = useState<McpPrompt[] | { error: string } | "loading" | null>(null);
  const [selected, setSelected] = useState<McpPrompt | null>(null);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);

  const load = () => {
    setState("loading");
    api.mcpPrompts(ws).then((r) => setState(r.prompts)).catch((e: unknown) => setState({ error: String(e) }));
  };

  const open = (prompt: McpPrompt) => {
    setArgs(Object.fromEntries((prompt.arguments ?? []).map((arg) => [arg.name, ""])));
    setSelected(prompt);
  };

  const usePrompt = async () => {
    if (!selected) return;
    setRunning(true);
    try {
      const result = await api.mcpPrompt(selected.server, selected.name, args, ws);
      if (useStore.getState().activeWorkspaceId !== ws) return;
      composeInChat(result.text);
      setSelected(null);
    } catch (e) {
      setState({ error: String(e) });
      setSelected(null);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 px-1">
        <h3 className="text-2xs uppercase tracking-wider text-tertiary">{t("settings.mcpPrompts")}</h3>
        <Button variant="ghost" size="sm" disabled={state === "loading"} onClick={load}>
          {state === "loading" ? t("settings.mcpListing") : state === null ? t("settings.mcpListPrompts") : t("settings.mcpRefresh")}
        </Button>
      </div>
      {state !== null && state !== "loading" && (
        <div className="mt-2">
          {Array.isArray(state) ? state.length === 0 ? (
            <p className="px-1 text-xs text-tertiary">{t("settings.mcpPromptsEmpty")}</p>
          ) : (
            <ul className="space-y-1">
              {state.map((prompt) => (
                <li key={`${prompt.server}:${prompt.name}`} className="flex items-center gap-2 rounded-lg border border-subtle bg-surface-raised px-2 py-1 text-xs">
                  <span className="font-mono text-accent">{prompt.server}</span>
                  <span className="min-w-0 flex-1 truncate text-secondary" title={prompt.description}>{prompt.name}{prompt.description ? ` — ${prompt.description}` : ""}</span>
                  <Button variant="ghost" size="sm" onClick={() => open(prompt)}>{t("settings.mcpUsePrompt")}</Button>
                </li>
              ))}
            </ul>
          ) : <p className="font-mono text-xs text-danger">{state.error}</p>}
        </div>
      )}
      {selected && (
        <ConfirmDialog
          title={`${selected.server} / ${selected.name}`}
          confirmLabel={running ? t("settings.mcpListing") : t("settings.mcpUsePrompt")}
          onConfirm={() => void usePrompt()}
          onCancel={() => setSelected(null)}
        >
          <div className="space-y-3">
            {selected.description && <p className="text-xs text-secondary">{selected.description}</p>}
            {(selected.arguments ?? []).map((arg) => (
              <label key={arg.name} className="block text-xs text-secondary">
                <span>{arg.name}{arg.required ? " *" : ""}</span>
                <Input value={args[arg.name] ?? ""} onChange={(e) => setArgs((current) => ({ ...current, [arg.name]: e.target.value }))} className="mt-1" />
              </label>
            ))}
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** Appearance (theme) + language + native notification on/off. All persist locally. */
function PreferencesSection() {
  const [notify, setNotify] = useState(notificationsEnabled());
  const t = useT();
  const locale = useLocale();
  return (
    <SettingsGroup title={t("settings.appearance")}>
      <SettingsRow label={t("settings.appearance")} description={t("settings.appearanceHint")}>
        <ThemeSwitcher />
      </SettingsRow>
      <SettingsRow label={t("lang.label")}>
        <Select
          value={locale}
          onChange={(v) => setLocale(v as Locale)}
          className="w-full"
          options={[
            { value: "en", label: t("lang.en") },
            { value: "zh-CN", label: t("lang.zh") },
          ]}
        />
      </SettingsRow>
      <SettingsRow label={t("settings.notifications")} description={t("settings.notifyLabel")}>
        <label className="flex items-center gap-2 self-center text-xs text-secondary">
          <input
            type="checkbox"
            checked={notify}
            onChange={(e) => {
              setNotify(e.target.checked);
              setNotificationsEnabled(e.target.checked);
            }}
            className="accent-accent"
          />
        </label>
      </SettingsRow>
    </SettingsGroup>
  );
}

export function SettingsView() {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [global, setGlobal] = useState(false);
  const { states, save } = useFieldSave();

  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [runtimeBin, setRuntimeBin] = useState("");
  const [allowlist, setAllowlist] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyMask, setApiKeyMask] = useState("");
  // The selectable model list (config.models), edited as comma-separated text.
  const [modelsList, setModelsList] = useState("");
  // Engine knobs (effective values are always present on GET /api/config).
  const [sandbox, setSandbox] = useState("off");
  const [compaction, setCompaction] = useState("mechanical");
  const [thinking, setThinking] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState("");
  // Agent behaviour knobs.
  const [planModel, setPlanModel] = useState("");
  const [escalateOnFailure, setEscalateOnFailure] = useState(false);
  const [memoryAutoApprove, setMemoryAutoApprove] = useState("");
  const ws = useStore((s) => s.activeWorkspaceId);

  useEffect(() => {
    setError(null);
    setLoading(true);
    api
      .config()
      .then((config) => {
        const list = config.models ?? [];
        setModelsList(list.join(", "));
        setModel(config.model ?? list[0] ?? "deepseek-v4-flash");
        setBaseUrl(config.baseUrl ?? "");
        setRuntimeBin(config.runtimeBin ?? "");
        setAllowlist((config.commandAllowlist ?? []).join(", "));
        setApiKeyMask(config.apiKey ?? "");
        setSandbox(config.sandbox ?? "off");
        setCompaction(config.compaction ?? "mechanical");
        setThinking(config.thinking ?? false);
        setReasoningEffort(config.reasoningEffort ?? "");
        setPlanModel(config.planModel ?? "");
        setEscalateOnFailure(config.escalateOnFailure ?? false);
        setMemoryAutoApprove(
          config.memoryAutoApproveConfidence === undefined || config.memoryAutoApproveConfidence === null
            ? ""
            : String(config.memoryAutoApproveConfidence),
        );
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [ws]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-subtle px-6 py-4">
        <IconSettings className="text-tertiary" />
        <h1 className="text-lg font-semibold text-primary">{t("settings.title")}</h1>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        {error && (
          <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 p-2 text-xs text-danger">{error}</div>
        )}
        {loading && !error ? (
          <p className="text-tertiary">{t("settings.loading")}</p>
        ) : (
          <div className="max-w-3xl space-y-6">
            <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-primary">{t("settings.scopeTitle")}</p>
                <p className="mt-0.5 text-xs text-tertiary">
                  {global ? t("settings.scopeUserHint") : t("settings.scopeProjectHint")}
                </p>
              </div>
              <div className="flex shrink-0 items-center rounded-lg border border-subtle p-0.5">
                {[
                  { user: false, label: t("settings.scopeProject") },
                  { user: true, label: t("settings.scopeUser") },
                ].map((opt) => (
                  <button
                    key={opt.label}
                    type="button"
                    onClick={() => setGlobal(opt.user)}
                    className={`focus-ring rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                      global === opt.user
                        ? "bg-accent-muted text-accent"
                        : "text-secondary hover:bg-accent-muted/60"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </Card>

            <PreferencesSection />

            {(() => {
              // The model list (config.models) is the source of truth for every
              // picker. The default model is chosen from it; ensure the current
              // default stays selectable even if not in the list.
              const parsed = modelsList.split(",").map((s) => s.trim()).filter(Boolean);
              const options = model && !parsed.includes(model) ? [model, ...parsed] : parsed;
              return (
                <SettingsGroup title={t("settings.model")}>
                  <SettingsRow label={t("settings.modelLabel")}>
                    <Select
                      value={model}
                      onChange={setModel}
                      className="w-full"
                      placeholder={t("settings.modelListEmpty")}
                      options={options.map((m) => ({ value: m, label: m }))}
                    />
                    <SaveButton
                      state={states.model ?? "idle"}
                      onClick={() => void save("model", model, global)}
                    />
                  </SettingsRow>
                  <SettingsRow label={t("settings.modelsLabel")} description={t("settings.modelsHint")} stacked>
                    <TextArea
                      value={modelsList}
                      onChange={(e) => setModelsList(e.target.value)}
                      placeholder={t("settings.modelsPlaceholder")}
                      rows={2}
                      spellCheck={false}
                      className="flex-1 resize-y font-mono"
                    />
                    <SaveButton
                      state={states.models ?? "idle"}
                      onClick={() => void save("models", modelsList, global)}
                    />
                  </SettingsRow>
                </SettingsGroup>
              );
            })()}

            <SettingsGroup title={t("settings.apiKey")}>
              <SettingsRow label={t("settings.baseUrlLabel")}>
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={t("settings.baseUrlPlaceholder")}
                  className="font-mono"
                />
                <SaveButton state={states.baseUrl ?? "idle"} onClick={() => void save("baseUrl", baseUrl, global)} />
              </SettingsRow>
              <SettingsRow label={t("settings.apiKeyLabel")} description={t("settings.apiKeyHint")}>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={apiKeyMask || t("settings.apiKeyPlaceholder")}
                  autoComplete="off"
                  className="font-mono"
                />
                <SaveButton
                  state={states.apiKey ?? "idle"}
                  onClick={() => {
                    if (apiKey.trim() === "") return;
                    void save("apiKey", apiKey, global).then((config) => {
                      if (config) {
                        setApiKey("");
                        setApiKeyMask(config.apiKey ?? "");
                      }
                    });
                  }}
                />
              </SettingsRow>
              <SettingsRow label={t("settings.runtimeBinLabel")}>
                <Input
                  value={runtimeBin}
                  onChange={(e) => setRuntimeBin(e.target.value)}
                  placeholder={t("settings.runtimeBinPlaceholder")}
                  className="font-mono"
                />
                <SaveButton
                  state={states.runtimeBin ?? "idle"}
                  onClick={() => void save("runtimeBin", runtimeBin, global)}
                />
              </SettingsRow>
            </SettingsGroup>

            <SettingsGroup title={t("settings.sandboxLabel")}>
              <SettingsRow label={t("settings.commandAllowlistLabel")} stacked>
                <TextArea
                  value={allowlist}
                  onChange={(e) => setAllowlist(e.target.value)}
                  placeholder={t("settings.allowlistPlaceholder")}
                  rows={3}
                  className="flex-1 resize-y font-mono"
                />
                <SaveButton
                  state={states.commandAllowlist ?? "idle"}
                  onClick={() => void save("commandAllowlist", allowlist, global)}
                />
              </SettingsRow>
              <SettingsRow label={t("settings.sandboxLabel")} description={t("settings.sandboxHint")}>
                <Select
                  value={sandbox}
                  onChange={setSandbox}
                  className="w-full"
                  options={[
                    { value: "off", label: t("settings.sandboxOff") },
                    { value: "read-only", label: t("settings.sandboxReadOnly") },
                    { value: "workspace-write", label: t("settings.sandboxWorkspaceWrite") },
                    { value: "restricted", label: t("settings.sandboxRestricted") },
                  ]}
                />
                <SaveButton state={states.sandbox ?? "idle"} onClick={() => void save("sandbox", sandbox, global)} />
              </SettingsRow>
              <SettingsRow label={t("settings.compactionLabel")}>
                <Select
                  value={compaction}
                  onChange={setCompaction}
                  className="w-full"
                  options={[
                    { value: "mechanical", label: t("settings.compactionMechanical") },
                    { value: "llm", label: t("settings.compactionLlm") },
                  ]}
                />
                <SaveButton
                  state={states.compaction ?? "idle"}
                  onClick={() => void save("compaction", compaction, global)}
                />
              </SettingsRow>
              <SettingsRow label={t("settings.reasoningEffortLabel")}>
                <Select
                  value={reasoningEffort}
                  onChange={setReasoningEffort}
                  className="w-full"
                  placeholder={t("settings.reasoningDefault")}
                  options={[
                    { value: "", label: t("settings.reasoningDefault") },
                    { value: "high", label: t("settings.reasoningHigh") },
                    { value: "max", label: t("settings.reasoningMax") },
                  ]}
                />
                <SaveButton
                  state={states.reasoningEffort ?? "idle"}
                  onClick={() => void save("reasoningEffort", reasoningEffort, global)}
                />
              </SettingsRow>
              <SettingsRow label={t("settings.thinkingLabel")}>
                <label className="flex items-center gap-2 self-center text-xs text-secondary">
                  <input
                    type="checkbox"
                    checked={thinking}
                    onChange={(e) => {
                      setThinking(e.target.checked);
                      void save("thinking", String(e.target.checked), global);
                    }}
                    className="accent-accent"
                  />
                </label>
              </SettingsRow>
            </SettingsGroup>

            <SettingsGroup title={t("settings.behaviorLabel")}>
              <SettingsRow label={t("settings.planModelLabel")} description={t("settings.planModelHint")}>
                <Input
                  value={planModel}
                  onChange={(e) => setPlanModel(e.target.value)}
                  placeholder={t("settings.planModelPlaceholder")}
                  className="font-mono"
                />
                <SaveButton
                  state={states.planModel ?? "idle"}
                  onClick={() => void save("planModel", planModel, global)}
                />
              </SettingsRow>
              <SettingsRow
                label={t("settings.memoryAutoApproveLabel")}
                description={t("settings.memoryAutoApproveHint")}
              >
                <Input
                  value={memoryAutoApprove}
                  onChange={(e) => setMemoryAutoApprove(e.target.value)}
                  inputMode="decimal"
                  placeholder={t("settings.memoryAutoApprovePlaceholder")}
                  className="font-mono"
                />
                <SaveButton
                  state={states.memoryAutoApproveConfidence ?? "idle"}
                  onClick={() => void save("memoryAutoApproveConfidence", memoryAutoApprove, global)}
                />
              </SettingsRow>
              <SettingsRow label={t("settings.escalateOnFailureLabel")}>
                <label className="flex items-center gap-2 self-center text-xs text-secondary">
                  <input
                    type="checkbox"
                    checked={escalateOnFailure}
                    onChange={(e) => {
                      setEscalateOnFailure(e.target.checked);
                      void save("escalateOnFailure", String(e.target.checked), global);
                    }}
                    className="accent-accent"
                  />
                </label>
              </SettingsRow>
            </SettingsGroup>

            <McpSection />
          </div>
        )}
      </div>
    </div>
  );
}
