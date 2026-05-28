import { useState } from "react";
import { api } from "../lib/api";
import { validateApiKeyFormat } from "../lib/onboarding";
import { Button, Input, LogoMark } from "./ui";

const DEEPSEEK_URL = "https://platform.deepseek.com/api_keys";

/**
 * First-run welcome shown ahead of the workbench when no API key is
 * configured. Saves the key through the same /api/config path SettingsView
 * uses (global config, like the TUI wizard). "Skip" drops into the app
 * read-only — the user can add a key later in Settings.
 *
 * `onDone` is called after a successful save or a skip; the host then
 * re-checks config and unmounts this screen.
 */
export function Onboarding({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const formatError = validateApiKeyFormat(apiKey);
    if (formatError) {
      setError(formatError);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      // Global config (~/.seekforge), mirroring the TUI onboarding wizard.
      await api.setConfig("apiKey", apiKey.trim(), true);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-surface p-6">
      <div className="w-full max-w-md rounded-xl border border-subtle bg-surface-raised p-7 shadow-2xl shadow-black/30">
        <div className="mb-5 flex items-center gap-2.5">
          <LogoMark size={28} className="text-accent" />
          <h1 className="text-lg font-semibold tracking-tight text-primary">
            Welcome to Seek<span className="text-accent">Forge</span>
          </h1>
        </div>

        <p className="mb-5 text-sm leading-relaxed text-secondary">
          SeekForge is a local-first coding agent powered by DeepSeek — chat, sessions, diffs, skills,
          sub-agents and memory in one desktop workbench. Add your DeepSeek API key to get started.
        </p>

        <label className="mb-1 block text-2xs uppercase tracking-wider text-tertiary">
          DeepSeek API key
        </label>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !saving) void save();
          }}
          placeholder="sk-…"
          autoComplete="off"
          autoFocus
          className="font-mono"
        />
        {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}

        <p className="mt-2 text-2xs text-tertiary">
          Stored in your global config (~/.seekforge). Get a key at{" "}
          <a
            href={DEEPSEEK_URL}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline-offset-2 hover:underline"
          >
            platform.deepseek.com
          </a>
          .
        </p>

        <div className="mt-6 flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={onSkip} disabled={saving}>
            Skip for now
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving || apiKey.trim() === ""}>
            {saving ? "Saving…" : "Save & continue"}
          </Button>
        </div>
      </div>
    </div>
  );
}
