import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { notificationsEnabled, setNotificationsEnabled } from "../lib/notify";
import { useStore } from "../store";
import { Badge, Button, Card, Input, TextArea } from "../components/ui";
import type { ConfigKey, McpResource, McpServer, McpTool, ModelInfo, ServerConfig } from "../types";

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
  return (
    <Button variant="ghost" size="md" onClick={onClick} disabled={state === "saving"} className="shrink-0">
      {state === "saving" ? "Saving…" : state === "saved" ? "Saved ✓" : state === "error" ? "Failed ✗" : "Save"}
    </Button>
  );
}

/** MCP servers list + on-demand tool listing (POST /api/mcp/:name/tools). */
function McpSection() {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Per server: tool list, an error string, or "loading". */
  const [tools, setTools] = useState<Record<string, McpTool[] | { error: string } | "loading">>({});
  const ws = useStore((s) => s.activeWorkspaceId);

  useEffect(() => {
    setServers(null);
    setLoadError(null);
    setTools({});
    api
      .mcp()
      .then(setServers)
      .catch((e: unknown) => setLoadError(String(e)));
  }, [ws]);

  const listTools = (name: string) => {
    setTools((t) => ({ ...t, [name]: "loading" }));
    api
      .mcpTools(name)
      .then((list) => setTools((t) => ({ ...t, [name]: list })))
      .catch((e: unknown) => setTools((t) => ({ ...t, [name]: { error: String(e) } })));
  };

  return (
    <div>
      <h2 className="mb-2 text-[10px] uppercase tracking-wider text-tertiary">mcp servers</h2>
      {loadError && (
        <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 p-2 text-xs text-danger">{loadError}</div>
      )}
      {servers === null ? (
        !loadError && <p className="text-sm text-tertiary">Loading…</p>
      ) : servers.length === 0 ? (
        <p className="text-sm text-tertiary">No MCP servers configured.</p>
      ) : (
        <div className="space-y-3">
          {servers.map((srv) => {
            const state = tools[srv.name];
            return (
              <Card key={srv.name} flush className="bg-surface-raised/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-primary">{srv.name}</span>
                  <Badge tone={srv.trusted ? "ok" : "neutral"}>{srv.trusted ? "trusted" : "untrusted"}</Badge>
                  {srv.envKeys !== undefined && <Badge tone="neutral">env: {srv.envKeys.length}</Badge>}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    disabled={state === "loading"}
                    onClick={() => listTools(srv.name)}
                  >
                    {state === "loading" ? "Listing…" : "List tools"}
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
      {servers !== null && servers.length > 0 && <McpResourcesSection />}
    </div>
  );
}

/**
 * Resources of every configured MCP server (GET /api/mcp/resources, spawned
 * on demand). Each row has a copy button for the @mcp:<server>:<uri> inline
 * reference syntax (paste it into a task to pull the resource in).
 */
function McpResourcesSection() {
  const [state, setState] = useState<McpResource[] | { error: string } | "loading" | null>(null);
  const [copiedUri, setCopiedUri] = useState<string | null>(null);

  const load = () => {
    setState("loading");
    api
      .mcpResources()
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
      <div className="flex items-center gap-2">
        <h3 className="text-[10px] uppercase tracking-wider text-tertiary">mcp resources</h3>
        <Button variant="ghost" size="sm" disabled={state === "loading"} onClick={load}>
          {state === "loading" ? "Listing…" : state === null ? "List resources" : "Refresh"}
        </Button>
      </div>
      {state !== null && state !== "loading" && (
        <div className="mt-2">
          {Array.isArray(state) ? (
            state.length === 0 ? (
              <p className="text-xs text-tertiary">No resources exposed by the configured servers.</p>
            ) : (
              <ul className="space-y-1">
                {state.map((r) => (
                  <li
                    key={`${r.server}:${r.uri}`}
                    className="flex items-center gap-2 rounded-lg border border-subtle bg-surface-raised/60 px-2 py-1 text-xs"
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
                      {copiedUri === `${r.server}:${r.uri}` ? "Copied ✓" : "Copy @mcp:…"}
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

/** Appearance (theme) + native notification on/off. Both persist locally. */
function PreferencesSection() {
  const [notify, setNotify] = useState(notificationsEnabled());
  return (
    <div className="space-y-3">
      <div>
        <h2 className="mb-2 text-[10px] uppercase tracking-wider text-tertiary">appearance</h2>
        <div className="flex items-center gap-3">
          <ThemeSwitcher />
          <span className="text-[11px] text-tertiary">Dark, light, or follow your system.</span>
        </div>
      </div>
      <div>
        <h2 className="mb-2 text-[10px] uppercase tracking-wider text-tertiary">notifications</h2>
        <label className="flex items-center gap-2 text-xs text-secondary">
          <input
            type="checkbox"
            checked={notify}
            onChange={(e) => {
              setNotify(e.target.checked);
              setNotificationsEnabled(e.target.checked);
            }}
            className="accent-accent"
          />
          Notify on permission requests (when unfocused) and finished tasks
        </label>
      </div>
    </div>
  );
}

const FIELD_LABEL = "mb-1 block text-[10px] uppercase tracking-wider text-tertiary";

export function SettingsView() {
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
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const ws = useStore((s) => s.activeWorkspaceId);

  useEffect(() => {
    setError(null);
    setLoading(true);
    setModels(null);
    Promise.all([
      api.models().catch(() => null as ModelInfo[] | null),
      api.config(),
    ])
      .then(([modelList, config]) => {
        if (modelList) setModels(modelList);
        const defaultModel =
          modelList?.find((m) => m.isDefault)?.id ?? config.model ?? "deepseek-chat";
        setModel(config.model ?? defaultModel);
        setBaseUrl(config.baseUrl ?? "");
        setRuntimeBin(config.runtimeBin ?? "");
        setAllowlist((config.commandAllowlist ?? []).join(", "));
        setApiKeyMask(config.apiKey ?? "");
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [ws]);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-subtle px-4 py-2">
        <h1 className="text-sm font-semibold text-primary">Settings</h1>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        {error && (
          <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 p-2 text-xs text-danger">{error}</div>
        )}
        {loading && !error ? (
          <p className="text-tertiary">Loading…</p>
        ) : (
          <div className="max-w-xl space-y-5">
            <label className="flex items-center gap-2 text-xs text-secondary">
              <input
                type="checkbox"
                checked={global}
                onChange={(e) => setGlobal(e.target.checked)}
                className="accent-accent"
              />
              Save to global config (~/.seekforge) instead of this project
            </label>

            <PreferencesSection />

            <div>
              <label className={FIELD_LABEL}>model</label>
              <div className="flex gap-2">
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full rounded-lg border border-strong bg-surface px-3 py-1.5 font-mono text-sm text-primary focus:border-accent/70 focus:outline-none focus:ring-1 focus:ring-accent/40"
                >
                  {models === null ? (
                    <option value="deepseek-chat">deepseek-chat</option>
                  ) : (
                    [
                      ...models
                        .filter((m) => !m.deprecated)
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.id}
                            {m.isDefault ? " (default)" : ""}
                          </option>
                        )),
                      ...models.filter((m) => m.deprecated).map((m) => (
                        <option key={m.id} value={m.id} disabled>
                          {m.id} (deprecated)
                        </option>
                      )),
                    ]
                  )}
                </select>
                <SaveButton state={states.model ?? "idle"} onClick={() => void save("model", model, global)} />
              </div>
            </div>

            <div>
              <label className={FIELD_LABEL}>baseUrl</label>
              <div className="flex gap-2">
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.deepseek.com"
                  className="font-mono"
                />
                <SaveButton state={states.baseUrl ?? "idle"} onClick={() => void save("baseUrl", baseUrl, global)} />
              </div>
            </div>

            <div>
              <label className={FIELD_LABEL}>runtimeBin</label>
              <div className="flex gap-2">
                <Input
                  value={runtimeBin}
                  onChange={(e) => setRuntimeBin(e.target.value)}
                  placeholder="/path/to/seekforge-runtime (optional)"
                  className="font-mono"
                />
                <SaveButton
                  state={states.runtimeBin ?? "idle"}
                  onClick={() => void save("runtimeBin", runtimeBin, global)}
                />
              </div>
            </div>

            <div>
              <label className={FIELD_LABEL}>commandAllowlist (comma-separated prefixes)</label>
              <div className="flex gap-2">
                <TextArea
                  value={allowlist}
                  onChange={(e) => setAllowlist(e.target.value)}
                  placeholder="pnpm test, pnpm typecheck, git status"
                  rows={3}
                  className="resize-y font-mono"
                />
                <SaveButton
                  state={states.commandAllowlist ?? "idle"}
                  onClick={() => void save("commandAllowlist", allowlist, global)}
                />
              </div>
            </div>

            <div>
              <label className={FIELD_LABEL}>apiKey</label>
              <div className="flex gap-2">
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={apiKeyMask || "sk-…"}
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
              </div>
              <p className="mt-1 text-[11px] text-tertiary">
                Shown masked. Type a new key and press Save to replace it.
              </p>
            </div>

            <McpSection />
          </div>
        )}
      </div>
    </div>
  );
}
