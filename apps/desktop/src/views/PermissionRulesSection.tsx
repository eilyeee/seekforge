import { useEffect, useId, useState } from "react";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { useStore } from "../store";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Badge, Button, Card, Input, Select, type BadgeTone } from "../components/ui";
import type { PermissionRuleEntry, PermissionRuleLayers, PermissionRuleScope } from "../types";
import { useWorkspaceAsyncCoordinator } from "./use-workspace-async";
import {
  actionsForScope,
  COMMON_RULE_TOOLS,
  formFromRule,
  ruleFromForm,
  type RuleAction,
  type RuleForm,
} from "./permission-rules-model";

const ACTION_TONE: Record<RuleAction, BadgeTone> = { deny: "danger", ask: "warn", allow: "ok" };

type Editor = { scope: PermissionRuleScope; entry?: PermissionRuleEntry; form: RuleForm };

/**
 * Settings → Permissions: the stored allow/deny/ask rules of both layers, in
 * evaluation order (project first), with add/edit/delete. Each edit names the
 * entry it replaces, so a concurrent change fails instead of hitting another rule.
 */
export function PermissionRulesSection() {
  const t = useT();
  const ws = useStore((s) => s.activeWorkspaceId);
  const coordinator = useWorkspaceAsyncCoordinator(ws, () => useStore.getState().activeWorkspaceId);
  const [layers, setLayers] = useState<PermissionRuleLayers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ scope: PermissionRuleScope; entry: PermissionRuleEntry } | null>(
    null,
  );

  useEffect(() => {
    const operation = coordinator.beginLatest(ws);
    if (!operation) return;
    setLayers(null);
    setError(null);
    setEditor(null);
    setPendingDelete(null);
    api
      .permissionRules(operation.workspaceId)
      .then((value) => {
        if (coordinator.isCurrent(operation)) setLayers(value);
      })
      .catch((e: unknown) => {
        if (coordinator.isCurrent(operation)) setError(String(e));
      });
  }, [coordinator, ws]);

  const run = (fn: (workspaceId: string) => Promise<PermissionRuleLayers>, onDone?: () => void) => {
    const operation = coordinator.capture(ws);
    if (!operation || busy) return;
    setBusy(true);
    setError(null);
    fn(operation.workspaceId)
      .then((value) => {
        if (!coordinator.isCurrent(operation)) return;
        setLayers(value);
        onDone?.();
      })
      .catch((e: unknown) => {
        if (coordinator.isCurrent(operation)) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (coordinator.isCurrent(operation)) setBusy(false);
      });
  };

  const save = (current: Editor) => {
    const built = ruleFromForm(current.form, current.scope);
    if (!built.ok) return;
    run(
      (w) =>
        current.entry
          ? api.permissionRuleUpdate(current.scope, current.entry, built.rule, w)
          : api.permissionRuleAdd(current.scope, built.rule, w),
      () => setEditor(null),
    );
  };

  const group = (scope: PermissionRuleScope, entries: PermissionRuleEntry[]) => (
    <div>
      <div className="mb-1.5 flex items-center gap-2 px-1">
        <span className="text-xs font-medium text-primary">
          {scope === "project" ? t("settings.rules.projectTitle") : t("settings.rules.userTitle")}
        </span>
        <span className="font-mono text-2xs text-tertiary">
          {scope === "project" ? ".seekforge/config.json" : "~/.seekforge/config.json"}
        </span>
      </div>
      {scope === "project" && <p className="mb-2 px-1 text-2xs text-tertiary">{t("settings.rules.projectHint")}</p>}
      {entries.length === 0 ? (
        <p className="px-1 text-2xs text-tertiary">{t("settings.rules.empty")}</p>
      ) : (
        <ul className="divide-y divide-subtle/60 rounded-lg border border-subtle">
          {entries.map((entry) => (
            <li key={entry.index} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
              {entry.rule ? (
                <>
                  <Badge tone={ACTION_TONE[entry.rule.action]}>{entry.rule.action}</Badge>
                  <span className="font-mono text-xs text-primary">{entry.rule.tool}</span>
                  {entry.rule.match !== undefined && (
                    <span className="min-w-0 truncate font-mono text-xs text-secondary" title={entry.rule.match}>
                      {entry.rule.match}
                    </span>
                  )}
                </>
              ) : (
                <span className="min-w-0 truncate font-mono text-xs text-danger" title={JSON.stringify(entry.raw)}>
                  {t("settings.rules.unreadable", { raw: JSON.stringify(entry.raw) ?? "undefined" })}
                </span>
              )}
              {!entry.effective && entry.rule && (
                <Badge tone="warn" title={t("settings.rules.ignoredHint")}>
                  {t("settings.rules.ignored")}
                </Badge>
              )}
              <span className="ml-auto flex gap-1.5">
                {entry.rule && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setEditor({ scope, entry, form: formFromRule(entry.rule, scope) })}
                  >
                    {t("settings.rules.edit")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  className="hover:text-danger"
                  onClick={() => setPendingDelete({ scope, entry })}
                >
                  {t("settings.rules.delete")}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <h2 className="text-2xs uppercase tracking-wider text-tertiary">{t("settings.rules.title")}</h2>
        <Button
          variant="ghost"
          size="sm"
          disabled={layers === null || busy}
          onClick={() => setEditor({ scope: "user", form: formFromRule(undefined, "user") })}
        >
          {t("settings.rules.add")}
        </Button>
      </div>
      <Card className="space-y-4 p-4">
        <p className="text-2xs text-tertiary">{t("settings.rules.description")}</p>
        {error && (
          <div className="rounded-lg border border-danger/40 bg-danger/10 p-2 text-xs text-danger">{error}</div>
        )}
        {layers === null ? (
          !error && <p className="text-sm text-tertiary">{t("settings.loading")}</p>
        ) : (
          <>
            {group("project", layers.project)}
            {group("user", layers.user)}
          </>
        )}
      </Card>

      {editor && (
        <RuleEditorDialog
          editor={editor}
          busy={busy}
          onChange={setEditor}
          onSave={() => save(editor)}
          onCancel={() => setEditor(null)}
        />
      )}
      {pendingDelete && (
        <ConfirmDialog
          title={t("settings.rules.deleteTitle")}
          confirmLabel={t("settings.rules.delete")}
          danger
          onConfirm={() => {
            const target = pendingDelete;
            setPendingDelete(null);
            run((w) => api.permissionRuleDelete(target.scope, target.entry, w));
          }}
          onCancel={() => setPendingDelete(null)}
        >
          <pre className="overflow-x-auto rounded-lg border border-subtle bg-surface p-2 font-mono text-xs">
            {JSON.stringify(pendingDelete.entry.raw)}
          </pre>
        </ConfirmDialog>
      )}
    </section>
  );
}

export function RuleEditorDialog({
  editor,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  editor: Editor;
  busy: boolean;
  onChange: (editor: Editor) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const toolsListId = useId();
  const built = ruleFromForm(editor.form, editor.scope);
  const setForm = (patch: Partial<RuleForm>) => onChange({ ...editor, form: { ...editor.form, ...patch } });
  const setScope = (scope: PermissionRuleScope) => {
    const actions = actionsForScope(scope);
    onChange({
      ...editor,
      scope,
      form: { ...editor.form, action: actions.includes(editor.form.action) ? editor.form.action : actions[0]! },
    });
  };
  return (
    <ConfirmDialog
      title={editor.entry ? t("settings.rules.editTitle") : t("settings.rules.addTitle")}
      confirmLabel={busy ? t("settings.saveSaving") : t("settings.saveBtn")}
      confirmDisabled={!built.ok || busy}
      onConfirm={onSave}
      onCancel={onCancel}
    >
      <div className="space-y-2.5 text-xs">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <span className="text-2xs uppercase tracking-wider text-tertiary">{t("settings.rules.scope")}</span>
            <Select
              value={editor.scope}
              disabled={editor.entry !== undefined}
              onChange={(value) => setScope(value as PermissionRuleScope)}
              ariaLabel={t("settings.rules.scope")}
              className="mt-1 w-full"
              options={[
                { value: "user", label: t("settings.rules.userTitle") },
                { value: "project", label: t("settings.rules.projectTitle") },
              ]}
            />
          </div>
          <div>
            <span className="text-2xs uppercase tracking-wider text-tertiary">{t("settings.rules.action")}</span>
            <Select
              value={editor.form.action}
              onChange={(value) => setForm({ action: value as RuleAction })}
              ariaLabel={t("settings.rules.action")}
              className="mt-1 w-full"
              options={actionsForScope(editor.scope).map((action) => ({
                value: action,
                label: t(`settings.rules.action.${action}`),
              }))}
            />
          </div>
        </div>
        {editor.scope === "project" && <p className="text-2xs text-tertiary">{t("settings.rules.projectHint")}</p>}
        <label className="block" htmlFor="rule-tool">
          <span className="text-2xs uppercase tracking-wider text-tertiary">{t("settings.rules.tool")}</span>
          <Input
            id="rule-tool"
            list={toolsListId}
            value={editor.form.tool}
            onChange={(e) => setForm({ tool: e.target.value })}
            placeholder="run_command"
            className="mt-1 font-mono"
          />
          <datalist id={toolsListId}>
            {COMMON_RULE_TOOLS.map((tool) => (
              <option key={tool} value={tool} />
            ))}
          </datalist>
        </label>
        <label className="block" htmlFor="rule-match">
          <span className="text-2xs uppercase tracking-wider text-tertiary">{t("settings.rules.match")}</span>
          <Input
            id="rule-match"
            value={editor.form.match}
            onChange={(e) => setForm({ match: e.target.value })}
            placeholder={t("settings.rules.matchPlaceholder")}
            className="mt-1 font-mono"
          />
        </label>
        <p className="text-2xs text-tertiary">{t("settings.rules.matchHint")}</p>
      </div>
    </ConfirmDialog>
  );
}
