import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ConfigKey, ServerConfig } from "../types";

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
        </div>
      </div>
    </div>
  );
}
