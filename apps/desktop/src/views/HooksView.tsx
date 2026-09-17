import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { useT } from "../lib/i18n";
import { Button, Card, IconShield, Input } from "../components/ui";
import { useWorkspaceAsyncCoordinator } from "./use-workspace-async";
import {
  BLOCKING_HOOK_STAGES,
  emptyHookEntry,
  fromHooksDraft,
  toHooksDraft,
  type ExtraFieldRow,
  type HookDraftEntry,
  type HooksDraft,
} from "./hooks-editor-model";

export function HooksView() {
  const t = useT();
  const ws = useStore((s) => s.activeWorkspaceId);
  const [draft, setDraft] = useState<HooksDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const requests = useWorkspaceAsyncCoordinator(ws, () => useStore.getState().activeWorkspaceId);

  useEffect(() => {
    const request = requests.beginLatest();
    if (!request) return;
    setDraft(null);
    setError(null);
    setNote(null);
    setSaving(false);
    api
      .hooks(request.workspaceId)
      .then((r) => {
        if (requests.isCurrent(request)) setDraft(toHooksDraft(r.hooks));
      })
      .catch((e: unknown) => {
        if (requests.isCurrent(request)) setError(String(e));
      });
  }, [ws]);

  const update = (stage: string, fn: (entries: HookDraftEntry[]) => HookDraftEntry[]) =>
    setDraft((d) => (d ? { ...d, entries: { ...d.entries, [stage]: fn(d.entries[stage] ?? []) } } : d));

  const addEntry = (stage: string) => update(stage, (es) => [...es, emptyHookEntry()]);
  const removeEntry = (stage: string, id: string) => update(stage, (es) => es.filter((e) => e.id !== id));
  const editEntry = (stage: string, id: string, patch: Partial<HookDraftEntry>) =>
    update(stage, (es) => es.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  const editExtra = (stage: string, entry: HookDraftEntry, extra: ExtraFieldRow[]) =>
    editEntry(stage, entry.id, { extra });

  const save = () => {
    if (!draft || saving) return;
    const built = fromHooksDraft(draft);
    if (!built.ok) {
      setError(t("hooks.invalidField", { stage: built.stage, error: built.error }));
      return;
    }
    const request = requests.beginLatest(ws);
    if (!request) return;
    setSaving(true);
    setError(null);
    setNote(null);
    api
      .saveHooks(built.hooks, request.workspaceId)
      .then((r) => {
        if (!requests.isCurrent(request)) return;
        setDraft(toHooksDraft(r.hooks));
        setNote(t("hooks.saved"));
      })
      .catch((e: unknown) => {
        if (requests.isCurrent(request)) setError(String(e));
      })
      .finally(() => {
        if (requests.isCurrent(request)) setSaving(false);
      });
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
        {error && <Card className="mb-3 border-danger/40 bg-danger/10 p-2 text-xs text-danger">{error}</Card>}
        {note && <p className="mb-3 text-2xs text-ok">{note}</p>}
        {draft === null ? (
          <p className="text-sm text-tertiary">{t("hooks.loading")}</p>
        ) : (
          <div className="space-y-4">
            {draft.stages.map((stage) => {
              const entries = draft.entries[stage] ?? [];
              return (
                <Card key={stage} className="p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <IconShield size={14} className="text-tertiary" />
                      <span className="font-mono text-sm text-primary">{stage}</span>
                      {BLOCKING_HOOK_STAGES.has(stage) && (
                        <span className="rounded bg-warn/15 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-warn">
                          {t("hooks.blocking")}
                        </span>
                      )}
                    </div>
                    <Button size="sm" onClick={() => addEntry(stage)}>
                      {t("hooks.addEntry")}
                    </Button>
                  </div>

                  {entries.length === 0 ? (
                    <p className="mt-2 text-2xs text-tertiary">{t("hooks.noEntries")}</p>
                  ) : (
                    <div className="mt-3 space-y-3">
                      {entries.map((entry) => (
                        <div key={entry.id} className="rounded-lg border border-subtle p-3">
                          <div className="flex items-center gap-2">
                            <Input
                              value={entry.command}
                              onChange={(e) => editEntry(stage, entry.id, { command: e.target.value })}
                              placeholder={t("hooks.commandPlaceholder")}
                              className="flex-1 font-mono text-xs"
                            />
                            <Button size="sm" onClick={() => removeEntry(stage, entry.id)}>
                              {t("hooks.removeEntry")}
                            </Button>
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-2">
                            <Input
                              value={entry.match}
                              onChange={(e) => editEntry(stage, entry.id, { match: e.target.value })}
                              placeholder={t("hooks.matchPlaceholder")}
                              className="font-mono text-xs"
                            />
                            <Input
                              value={entry.pattern}
                              onChange={(e) => editEntry(stage, entry.id, { pattern: e.target.value })}
                              placeholder={t("hooks.patternPlaceholder")}
                              className="font-mono text-xs"
                            />
                          </div>
                          <ExtraFields rows={entry.extra} onChange={(rows) => editExtra(stage, entry, rows)} />
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** Other fields of an entry (hook type, url, timeout…) as editable JSON values. */
function ExtraFields({ rows, onChange }: { rows: ExtraFieldRow[]; onChange: (rows: ExtraFieldRow[]) => void }) {
  const t = useT();
  const set = (index: number, patch: Partial<ExtraFieldRow>) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <div className="mt-2">
      {rows.length > 0 && (
        <div className="mb-1 text-2xs uppercase tracking-wider text-tertiary">{t("hooks.extraFields")}</div>
      )}
      <div className="space-y-1.5">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              value={row.key}
              onChange={(e) => set(index, { key: e.target.value })}
              placeholder={t("hooks.extraKeyPlaceholder")}
              aria-label={t("hooks.extraKeyPlaceholder")}
              className="w-36 font-mono text-xs"
            />
            <Input
              value={row.json}
              onChange={(e) => set(index, { json: e.target.value })}
              placeholder={t("hooks.extraValuePlaceholder")}
              aria-label={t("hooks.extraValuePlaceholder")}
              className="flex-1 font-mono text-xs"
            />
            <Button size="sm" variant="ghost" onClick={() => onChange(rows.filter((_, at) => at !== index))}>
              ×
            </Button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...rows, { key: "", json: '""' }])}
        className="focus-ring mt-1.5 rounded text-2xs text-accent hover:text-accent-hover"
      >
        {t("hooks.addExtraField")}
      </button>
    </div>
  );
}
