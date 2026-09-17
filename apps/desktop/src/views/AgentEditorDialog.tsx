import { useState } from "react";
import { useT } from "../lib/i18n";
import { Button, Input, Modal, Select, TextArea } from "../components/ui";
import type { AgentDefinitionDraft, AgentDefinitionScope } from "../types";
import { draftFromForm, type AgentEditorForm } from "./agent-editor-model";

type Props = {
  /** "create" lets the user pick id and scope; "edit" keeps both fixed. */
  intent: "create" | "edit";
  initial: AgentEditorForm;
  path?: string;
  onSave: (id: string, scope: AgentDefinitionScope, draft: AgentDefinitionDraft) => Promise<void>;
  onClose: () => void;
};

/**
 * Create or edit one subagent definition. Frontmatter entries this form does
 * not own are listed generically (key + raw YAML value), so fields a newer
 * loader understands survive an edit; untouched ones are rewritten verbatim.
 */
export function AgentEditorDialog({ intent, initial, path, onSave, onClose }: Props) {
  const t = useT();
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<AgentEditorForm>) => setForm((current) => ({ ...current, ...patch }));
  const built = draftFromForm(form);

  const submit = () => {
    if (!built.ok || busy) return;
    setBusy(true);
    setError(null);
    onSave(form.id, form.scope, built.draft)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const setExtra = (index: number, patch: Partial<{ key: string; value: string }>) =>
    set({ extra: form.extra.map((field, at) => (at === index ? { ...field, ...patch } : field)) });

  return (
    <Modal
      wide
      onDismiss={onClose}
      title={intent === "create" ? t("agents.editor.createTitle") : t("agents.editor.editTitle", { id: form.id })}
      footer={
        <>
          <Button onClick={onClose}>{t("action.cancel")}</Button>
          <Button variant="primary" onClick={submit} disabled={!built.ok || busy}>
            {busy ? t("settings.saveSaving") : t("agents.editor.save")}
          </Button>
        </>
      }
    >
      <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1 text-xs">
        {path && <p className="break-all font-mono text-2xs text-tertiary">{path}</p>}
        <div className="grid grid-cols-2 gap-2">
          <label htmlFor="agent-id">
            <span className="text-2xs uppercase tracking-wider text-tertiary">{t("agents.editor.id")}</span>
            <Input
              id="agent-id"
              value={form.id}
              disabled={intent === "edit"}
              onChange={(e) => set({ id: e.target.value.toLowerCase() })}
              placeholder="code-reviewer"
              className="mt-1 font-mono"
            />
          </label>
          <div>
            <span className="text-2xs uppercase tracking-wider text-tertiary">{t("agents.editor.scope")}</span>
            <Select
              value={form.scope}
              disabled={intent === "edit"}
              onChange={(value) => set({ scope: value as AgentDefinitionScope })}
              ariaLabel={t("agents.editor.scope")}
              className="mt-1 w-full"
              options={[
                { value: "project", label: t("agents.editor.scopeProject") },
                { value: "global", label: t("agents.editor.scopeGlobal") },
              ]}
            />
          </div>
        </div>
        {!built.ok && built.error === "id" && form.id !== "" && (
          <p className="text-2xs text-danger">{t("agents.editor.idInvalid")}</p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <label htmlFor="agent-name">
            <span className="text-2xs uppercase tracking-wider text-tertiary">{t("agents.editor.name")}</span>
            <Input id="agent-name" value={form.name} onChange={(e) => set({ name: e.target.value })} className="mt-1" />
          </label>
          <div>
            <span className="text-2xs uppercase tracking-wider text-tertiary">{t("agents.editor.mode")}</span>
            <Select
              value={form.mode}
              onChange={(value) => set({ mode: value as "ask" | "edit" })}
              ariaLabel={t("agents.editor.mode")}
              className="mt-1 w-full"
              options={[
                { value: "edit", label: t("agents.editor.modeEdit") },
                { value: "ask", label: t("agents.editor.modeAsk") },
              ]}
            />
          </div>
        </div>
        <label className="block" htmlFor="agent-description">
          <span className="text-2xs uppercase tracking-wider text-tertiary">{t("agents.editor.description")}</span>
          <TextArea
            id="agent-description"
            value={form.description}
            rows={2}
            onChange={(e) => set({ description: e.target.value })}
            className="mt-1"
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label htmlFor="agent-model">
            <span className="text-2xs uppercase tracking-wider text-tertiary">{t("agents.editor.model")}</span>
            <Input
              id="agent-model"
              value={form.model}
              onChange={(e) => set({ model: e.target.value })}
              placeholder={t("agents.defaultModel")}
              className="mt-1 font-mono"
            />
          </label>
          <label htmlFor="agent-max-turns">
            <span className="text-2xs uppercase tracking-wider text-tertiary">{t("agents.editor.maxTurns")}</span>
            <Input
              id="agent-max-turns"
              value={form.maxTurns}
              inputMode="numeric"
              onChange={(e) => set({ maxTurns: e.target.value.replace(/[^0-9]/g, "") })}
              placeholder="15"
              className="mt-1 font-mono"
            />
          </label>
        </div>
        <div>
          <label className="flex items-center gap-2 text-secondary">
            <input
              type="checkbox"
              checked={form.restrictTools}
              onChange={(e) => set({ restrictTools: e.target.checked })}
              className="accent-accent"
            />
            {t("agents.editor.restrictTools")}
          </label>
          {form.restrictTools && (
            <Input
              aria-label={t("agents.editor.tools")}
              value={form.tools}
              onChange={(e) => set({ tools: e.target.value })}
              placeholder="read_file, search_text, run_command"
              className="mt-1 font-mono"
            />
          )}
          {!built.ok && built.error === "tools" && (
            <p className="mt-1 text-2xs text-danger">{t("agents.editor.toolsInvalid")}</p>
          )}
        </div>
        <label className="block" htmlFor="agent-body">
          <span className="text-2xs uppercase tracking-wider text-tertiary">{t("agents.editor.body")}</span>
          <TextArea
            id="agent-body"
            value={form.body}
            rows={8}
            onChange={(e) => set({ body: e.target.value })}
            placeholder={t("agents.editor.bodyPlaceholder")}
            className="mt-1 resize-y font-mono"
          />
        </label>

        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="text-2xs uppercase tracking-wider text-tertiary">{t("agents.editor.extra")}</span>
            <button
              type="button"
              onClick={() => set({ extra: [...form.extra, { key: "", value: "" }] })}
              className="focus-ring ml-auto rounded text-2xs text-accent hover:text-accent-hover"
            >
              {t("agents.editor.addExtra")}
            </button>
          </div>
          <p className="mb-1.5 text-2xs text-tertiary">{t("agents.editor.extraHint")}</p>
          <div className="space-y-1.5">
            {form.extra.map((field, index) => (
              <div key={index} className="flex items-start gap-2">
                <Input
                  value={field.key}
                  aria-label={t("agents.editor.extraKey")}
                  onChange={(e) => setExtra(index, { key: e.target.value })}
                  placeholder="trigger"
                  className="w-36 font-mono text-xs"
                />
                <TextArea
                  value={field.value}
                  aria-label={t("agents.editor.extraValue")}
                  rows={Math.min(6, Math.max(1, field.value.split("\n").length))}
                  onChange={(e) => setExtra(index, { value: e.target.value })}
                  className="flex-1 resize-y font-mono text-xs"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => set({ extra: form.extra.filter((_, at) => at !== index) })}
                >
                  ×
                </Button>
              </div>
            ))}
          </div>
          {!built.ok && (built.error === "extraKey" || built.error === "extraDuplicate") && (
            <p className="mt-1 text-2xs text-danger">{t(`agents.editor.error.${built.error}`)}</p>
          )}
        </div>
        {!built.ok && built.error === "maxTurns" && (
          <p className="text-2xs text-danger">{t("agents.editor.maxTurnsInvalid")}</p>
        )}
        {error && <p className="whitespace-pre-wrap font-mono text-2xs text-danger">{error}</p>}
      </div>
    </Modal>
  );
}
