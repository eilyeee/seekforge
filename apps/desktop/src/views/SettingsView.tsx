import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ConfigKey, McpServer, McpTool, ServerConfig } from "../types";

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
    <button
      type="button"
      onClick={onClick}
      disabled={state === "saving"}
      className="shrink-0 rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
    >
      {state === "saving" ? "Saving…" : state === "saved" ? "Saved ✓" : state === "error" ? "Failed ✗" : "Save"}
    </button>
  );
}

/** MCP servers list + on-demand tool listing (POST /api/mcp/:name/tools). */
function McpSection() {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Per server: tool list, an error string, or "loading". */
  const [tools, setTools] = useState<Record<string, McpTool[] | { error: string } | "loading">>({});

  useEffect(() => {
    api
      .mcp()
      .then(setServers)
      .catch((e: unknown) => setLoadError(String(e)));
  }, []);

  const listTools = (name: string) => {
    setTools((t) => ({ ...t, [name]: "loading" }));
    api
      .mcpTools(name)
      .then((list) => setTools((t) => ({ ...t, [name]: list })))
      .catch((e: unknown) => setTools((t) => ({ ...t, [name]: { error: String(e) } })));
  };

  return (
    <div>
      <h2 className="mb-2 text-[10px] uppercase tracking-wider text-zinc-500">mcp servers</h2>
      {loadError && (
        <div className="mb-3 rounded border border-red-900 bg-red-950/40 p-2 text-xs text-red-300">{loadError}</div>
      )}
      {servers === null ? (
        <p className="text-sm text-zinc-600">Loading…</p>
      ) : servers.length === 0 ? (
        <p className="text-sm text-zinc-600">No MCP servers configured.</p>
      ) : (
        <div className="space-y-3">
          {servers.map((srv) => {
            const state = tools[srv.name];
            return (
              <div key={srv.name} className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-zinc-100">{srv.name}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${
                      srv.trusted ? "bg-emerald-900 text-emerald-200" : "bg-zinc-800 text-zinc-400"
                    }`}
                  >
                    {srv.trusted ? "trusted" : "untrusted"}
                  </span>
                  {srv.envKeys !== undefined && (
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                      env: {srv.envKeys.length}
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={state === "loading"}
                    onClick={() => listTools(srv.name)}
                    className="ml-auto rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {state === "loading" ? "Listing…" : "List tools"}
                  </button>
                </div>
                <div className="mt-1.5 font-mono text-xs text-zinc-500">
                  {srv.command} {srv.args.join(" ")}
                </div>
                {state !== undefined && state !== "loading" && (
                  <div className="mt-2 border-t border-zinc-800 pt-2">
                    {Array.isArray(state) ? (
                      <ul className="space-y-1">
                        {state.map((tool) => (
                          <li key={tool.name} className="text-xs">
                            <span className="font-mono text-emerald-300">{tool.name}</span>
                            <span className="ml-2 text-zinc-400">{tool.description}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="font-mono text-xs text-red-300">{state.error}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const FIELD_LABEL = "mb-1 block text-[10px] uppercase tracking-wider text-zinc-500";
const FIELD_INPUT =
  "w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-700 focus:outline-none";

export function SettingsView() {
  const [error, setError] = useState<string | null>(null);
  const [global, setGlobal] = useState(false);
  const { states, save } = useFieldSave();

  const [model, setModel] = useState("deepseek-chat");
  const [baseUrl, setBaseUrl] = useState("");
  const [runtimeBin, setRuntimeBin] = useState("");
  const [allowlist, setAllowlist] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyMask, setApiKeyMask] = useState("");

  useEffect(() => {
    api
      .config()
      .then((config) => {
        setModel(config.model ?? "deepseek-chat");
        setBaseUrl(config.baseUrl ?? "");
        setRuntimeBin(config.runtimeBin ?? "");
        setAllowlist((config.commandAllowlist ?? []).join(", "));
        setApiKeyMask(config.apiKey ?? "");
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-zinc-800 px-4 py-2">
        <h1 className="text-sm font-semibold text-zinc-100">Settings</h1>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        {error && <div className="mb-3 rounded border border-red-900 bg-red-950/40 p-2 text-xs text-red-300">{error}</div>}
        <div className="max-w-xl space-y-5">
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={global}
              onChange={(e) => setGlobal(e.target.checked)}
              className="accent-emerald-600"
            />
            Save to global config (~/.seekforge) instead of this project
          </label>

          <div>
            <label className={FIELD_LABEL}>model</label>
            <div className="flex gap-2">
              <select value={model} onChange={(e) => setModel(e.target.value)} className={FIELD_INPUT}>
                <option value="deepseek-chat">deepseek-chat</option>
                <option value="deepseek-reasoner" disabled>
                  deepseek-reasoner (no tool calling yet)
                </option>
              </select>
              <SaveButton state={states.model ?? "idle"} onClick={() => void save("model", model, global)} />
            </div>
            <p className="mt-1 text-[11px] text-zinc-600">
              deepseek-reasoner is disabled: it does not support tool calling yet.
            </p>
          </div>

          <div>
            <label className={FIELD_LABEL}>baseUrl</label>
            <div className="flex gap-2">
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.deepseek.com"
                className={FIELD_INPUT}
              />
              <SaveButton state={states.baseUrl ?? "idle"} onClick={() => void save("baseUrl", baseUrl, global)} />
            </div>
          </div>

          <div>
            <label className={FIELD_LABEL}>runtimeBin</label>
            <div className="flex gap-2">
              <input
                value={runtimeBin}
                onChange={(e) => setRuntimeBin(e.target.value)}
                placeholder="/path/to/seekforge-runtime (optional)"
                className={FIELD_INPUT}
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
              <textarea
                value={allowlist}
                onChange={(e) => setAllowlist(e.target.value)}
                placeholder="pnpm test, pnpm typecheck, git status"
                rows={3}
                className={`${FIELD_INPUT} resize-y`}
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
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={apiKeyMask || "sk-…"}
                autoComplete="off"
                className={FIELD_INPUT}
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
            <p className="mt-1 text-[11px] text-zinc-600">
              Shown masked. Type a new key and press Save to replace it.
            </p>
          </div>

          <McpSection />
        </div>
      </div>
    </div>
  );
}
