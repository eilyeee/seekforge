import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { useT } from "../lib/i18n";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Badge, Button, EmptyState, IconGit, TextArea, type BadgeTone } from "../components/ui";
import type { GitFile, GitFileStatus, GitStatus } from "../types";

const STATUS_TONE: Record<GitFileStatus, BadgeTone> = {
  modified: "warn",
  added: "ok",
  deleted: "danger",
  renamed: "accent",
  untracked: "neutral",
};

export function GitView() {
  const t = useT();
  const ws = useStore((s) => s.activeWorkspaceId);

  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [discardTarget, setDiscardTarget] = useState<string | null>(null);

  const refresh = () =>
    api
      .gitStatus()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e: unknown) => setError(String(e)));

  useEffect(() => {
    setStatus(null);
    setError(null);
    setNote(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  const mutate = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNote(null);
    fn()
      .then(refresh)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const stage = (paths: string[]) => mutate(() => api.gitStage(paths));
  const unstage = (paths: string[]) => mutate(() => api.gitUnstage(paths));

  const discard = (path: string) => {
    setDiscardTarget(null);
    mutate(() => api.gitDiscard([path]));
  };

  const commit = () => {
    const msg = message.trim();
    if (msg === "") return;
    setCommitting(true);
    setNote(null);
    api
      .gitCommit(msg)
      .then((r) => {
        setMessage("");
        setNote(t("git.committed", { commit: r.commit }));
        return refresh();
      })
      .catch((e: unknown) => setError(t("git.commitError", { error: String(e) })))
      .finally(() => setCommitting(false));
  };

  const staged = status?.files.filter((f) => f.staged) ?? [];
  const unstaged = status?.files.filter((f) => !f.staged) ?? [];
  const canCommit = staged.length > 0 && message.trim() !== "" && !committing;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-subtle px-6 py-4">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-primary">{t("git.title")}</h1>
          {status && !status.notGit && status.branch && (
            <span className="font-mono text-2xs text-tertiary">{t("git.branch", { branch: status.branch })}</span>
          )}
        </div>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-tertiary">{t("git.description")}</p>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {error && (
          <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        {status === null ? (
          !error && <p className="text-sm text-tertiary">{t("git.loading")}</p>
        ) : status.notGit ? (
          <EmptyState
            icon={<IconGit size={28} />}
            title={t("git.notGitTitle")}
            description={t("git.notGitDescription")}
          />
        ) : status.files.length === 0 ? (
          <EmptyState
            icon={<IconGit size={28} />}
            title={t("git.cleanTitle")}
            description={t("git.cleanDescription")}
          />
        ) : (
          <div className="mx-auto max-w-2xl space-y-6">
            {/* Commit box */}
            <div>
              <TextArea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={t("git.commitPlaceholder")}
                rows={3}
                disabled={committing}
              />
              <div className="mt-2 flex items-center gap-2">
                {note && <span className="text-2xs text-ok">{note}</span>}
                <Button variant="primary" size="sm" className="ml-auto" onClick={commit} disabled={!canCommit}>
                  {committing ? t("git.committing") : t("git.commit")}
                </Button>
              </div>
            </div>

            <Section
              title={t("git.stagedSection", { count: staged.length })}
              files={staged}
              action={t("git.unstage")}
              onAction={(p) => unstage([p])}
              bulkLabel={t("git.unstageAll")}
              onBulk={staged.length > 0 ? () => unstage(staged.map((f) => f.path)) : undefined}
              busy={busy}
            />

            <Section
              title={t("git.unstagedSection", { count: unstaged.length })}
              files={unstaged}
              action={t("git.stage")}
              onAction={(p) => stage([p])}
              bulkLabel={t("git.stageAll")}
              onBulk={unstaged.length > 0 ? () => stage(unstaged.map((f) => f.path)) : undefined}
              busy={busy}
              onDiscard={setDiscardTarget}
            />
          </div>
        )}
      </div>

      {discardTarget !== null && (
        <ConfirmDialog
          title={t("git.discardTitle")}
          confirmLabel={t("git.discardConfirm")}
          danger
          onConfirm={() => discard(discardTarget)}
          onCancel={() => setDiscardTarget(null)}
        >
          {t("git.discardBody", { path: discardTarget })}
        </ConfirmDialog>
      )}
    </div>
  );
}

function Section({
  title,
  files,
  action,
  onAction,
  bulkLabel,
  onBulk,
  busy,
  onDiscard,
}: {
  title: string;
  files: GitFile[];
  action: string;
  onAction: (path: string) => void;
  bulkLabel: string;
  onBulk?: () => void;
  busy: boolean;
  onDiscard?: (path: string) => void;
}) {
  const t = useT();
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-2xs uppercase tracking-wider text-tertiary">{title}</h2>
        <span className="h-px flex-1 border-t border-subtle" />
        {onBulk && (
          <Button variant="ghost" size="sm" onClick={onBulk} disabled={busy}>
            {bulkLabel}
          </Button>
        )}
      </div>
      {files.length === 0 ? null : (
        <ul className="divide-y divide-subtle/60 rounded-lg border border-subtle">
          {files.map((f) => (
            <li key={f.path} className="group flex items-center gap-2 px-3 py-1.5">
              <Badge tone={STATUS_TONE[f.status]} title={f.status}>
                {t(`git.status.${f.status}`)}
              </Badge>
              <button
                type="button"
                onClick={() => useStore.getState().openFileAt(f.path)}
                title={t("git.openFileTitle")}
                className="min-w-0 flex-1 truncate text-left font-mono text-xs text-secondary hover:text-primary"
              >
                {f.path}
              </button>
              {onDiscard && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="opacity-0 hover:text-danger group-hover:opacity-100"
                  onClick={() => onDiscard(f.path)}
                  disabled={busy}
                >
                  {t("git.discard")}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => onAction(f.path)} disabled={busy}>
                {action}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
