import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { useT } from "../lib/i18n";
import { Button, Card, IconShield, Input } from "../components/ui";
import { HOOK_STAGES, type HookEntry, type HookStage, type HooksConfig } from "../types";

/** Stages where a non-zero exit (or JSON deny) blocks the tool/run. */
const BLOCKING: ReadonlySet<HookStage> = new Set(["preToolUse", "userPromptSubmit"]);

/** A local, always-array view of the hooks config so editing is uniform. */
type Draft = Record<HookStage, HookEntry[]>;

function toDraft(cfg: HooksConfig): Draft {
  const d = {} as Draft;
  for (const stage of HOOK_STAGES) d[stage] = cfg[stage] ? cfg[stage]!.map((e) => ({ ...e })) : [];
  return d;
}

/** Drop empty stages and trim away blank optional fields before saving. */
function toConfig(draft: Draft): HooksConfig {
  const out: HooksConfig = {};
  for (const stage of HOOK_STAGES) {
    const entries = draft[stage]
      .filter((e) => e.command.trim() !== "")
      .map((e) => ({
        command: e.command.trim(),
        ...(e.match && e.match.trim() !== "" ? { match: e.match.trim() } : {}),
        ...(e.pattern && e.pattern.trim() !== "" ? { pattern: e.pattern.trim() } : {}),
      }));
    if (entries.length > 0) out[stage] = entries;
  }
  return out;
}

export function HooksView() {
  const t = useT();
  const ws = useStore((s) => s.activeWorkspaceId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(null);
    setError(null);
    setNote(null);
    api
      .hooks()
      .then((r) => setDraft(toDraft(r.hooks)))
      .catch((e: unknown) => setError(String(e)));
  }, [ws]);

  const update = (stage: HookStage, fn: (entries: HookEntry[]) => HookEntry[]) =>
    setDraft((d) => (d ? { ...d, [stage]: fn(d[stage]) } : d));

  const addEntry = (stage: HookStage) => update(stage, (es) => [...es, { command: "" }]);
  const removeEntry = (stage: HookStage, i: number) =>
    update(stage, (es) => es.filter((_, idx) => idx !== i));
  const editEntry = (stage: HookStage, i: number, patch: Partial<HookEntry>) =>
    update(stage, (es) => es.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));

  const save = () => {
    if (!draft || saving) return;
    setSaving(true);
    setError(null);
    setNote(null);
    api
      .saveHooks(toConfig(draft))
      .then((r) => {
        setDraft(toDraft(r.hooks));
        setNote(t("hooks.saved"));
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex items-start justify-between gap-4 border-b border-subtle px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-primary">{t("hooks.title")}</h1>
          <p className="mt-1 max-w-2xl text-xs text-tertiary">{t("hooks.description")}</p>
        </div>
        <Button variant="primary" size="sm" className="shrink-0" onClick={save} disabled={!draft || saving}>
          {saving ? "…" : t("hooks.save")}
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <Card className="mb-3 border-danger/40 bg-danger/10 p-2 text-xs text-danger">{error}</Card>
        )}
        {note && <p className="mb-3 text-2xs text-ok">{note}</p>}
        {draft === null ? (
          <p className="text-sm text-tertiary">{t("hooks.loading")}</p>
        ) : (
          <div className="space-y-4">
            {HOOK_STAGES.map((stage) => (
              <Card key={stage} className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <IconShield size={14} className="text-tertiary" />
                    <span className="font-mono text-sm text-primary">{stage}</span>
                    {BLOCKING.has(stage) && (
                      <span className="rounded bg-warn/15 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-warn">
                        {t("hooks.blocking")}
                      </span>
                    )}
                  </div>
                  <Button size="sm" onClick={() => addEntry(stage)}>
                    {t("hooks.addEntry")}
                  </Button>
                </div>

                {draft[stage].length === 0 ? (
                  <p className="mt-2 text-2xs text-tertiary">{t("hooks.noEntries")}</p>
                ) : (
                  <div className="mt-3 space-y-3">
                    {draft[stage].map((entry, i) => (
                      <div key={i} className="rounded-lg border border-subtle p-3">
                        <div className="flex items-center gap-2">
                          <Input
                            value={entry.command}
                            onChange={(e) => editEntry(stage, i, { command: e.target.value })}
                            placeholder={t("hooks.commandPlaceholder")}
                            className="flex-1 font-mono text-xs"
                          />
                          <Button size="sm" onClick={() => removeEntry(stage, i)}>
                            {t("hooks.removeEntry")}
                          </Button>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <Input
                            value={entry.match ?? ""}
                            onChange={(e) => editEntry(stage, i, { match: e.target.value })}
                            placeholder={t("hooks.matchPlaceholder")}
                            className="font-mono text-xs"
                          />
                          <Input
                            value={entry.pattern ?? ""}
                            onChange={(e) => editEntry(stage, i, { pattern: e.target.value })}
                            placeholder={t("hooks.patternPlaceholder")}
                            className="font-mono text-xs"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
