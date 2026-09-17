import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { activeTab, useStore } from "../store";
import { diffTotals, filterToPaths, splitDiffByFile, splitFileHunks, type FileDiff } from "../lib/diff-files";
import { langFromPath } from "../lib/highlight";
import { DiffBlock } from "../components/DiffBlock";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useT } from "../lib/i18n";
import { Badge, Button, Card, EmptyState, IconChevron, IconDiff, IconSparkle, Select } from "../components/ui";
import type { GitHunkAction } from "../types";
import { ExclusiveOperation } from "./async-coordination";
import { useWorkspaceAsyncCoordinator } from "./use-workspace-async";

type FileAction = "stage" | "unstage" | "revert";

type PendingConfirm =
  | { kind: "revertFile"; path: string }
  | { kind: "revertHunk"; path: string; hunk: string }
  | { kind: "deleteUntracked"; path: string };

function FileSection({
  file,
  staged,
  busy,
  onFileAction,
  onHunkAction,
}: {
  file: FileDiff;
  staged: boolean;
  busy: boolean;
  onFileAction: (path: string, action: FileAction) => void;
  onHunkAction: (path: string, hunk: string, action: GitHunkAction) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const split = useMemo(() => splitFileHunks(file.text), [file.text]);
  const lang = useMemo(() => langFromPath(file.path), [file.path]);
  return (
    <Card flush className="overflow-hidden">
      <div className="flex w-full flex-wrap items-center gap-2.5 px-4 py-2.5 hover:bg-surface-overlay/60">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="focus-ring flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <span className="text-tertiary">
            <IconChevron size={12} className={open ? "rotate-90" : ""} />
          </span>
          <span className="flex-1 truncate font-mono text-xs text-primary">{file.path}</span>
        </button>
        <Badge tone="ok">+{file.additions}</Badge>
        <Badge tone="danger">-{file.deletions}</Badge>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => useStore.getState().openFileAt(file.path)}
          title={t("diff.openFileTitle")}
        >
          {t("diff.openFile")}
        </Button>
        {staged ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onFileAction(file.path, "unstage")}>
            {t("diff.unstageFile")}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              className="hover:text-danger"
              onClick={() => onFileAction(file.path, "revert")}
              title={t("diff.revertFileTitle")}
            >
              {t("diff.revertFile")}
            </Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => onFileAction(file.path, "stage")}>
              {t("diff.stageFile")}
            </Button>
          </>
        )}
      </div>
      {open && (
        <div className="space-y-2 px-3 pb-3">
          {split.actionable ? (
            split.hunks.map((hunk, index) => (
              <div key={`${index}:${hunk.slice(0, 40)}`}>
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-2xs uppercase tracking-wider text-tertiary">
                    {t("diff.hunkLabel", { n: index + 1, total: split.hunks.length })}
                  </span>
                  <span className="ml-auto flex gap-1.5">
                    {staged ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => onHunkAction(file.path, hunk, "unstage")}
                      >
                        {t("diff.unstageHunk")}
                      </Button>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          className="hover:text-danger"
                          onClick={() => onHunkAction(file.path, hunk, "revert")}
                        >
                          {t("diff.revertHunk")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => onHunkAction(file.path, hunk, "stage")}
                        >
                          {t("diff.stageHunk")}
                        </Button>
                      </>
                    )}
                  </span>
                </div>
                <DiffBlock diff={hunk} lang={lang} />
              </div>
            ))
          ) : (
            <DiffBlock diff={file.text} />
          )}
        </div>
      )}
    </Card>
  );
}

export function DiffView() {
  const t = useT();
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const [untracked, setUntracked] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [staged, setStaged] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [notGit, setNotGit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [scope, setScope] = useState<"all" | "session">("all");
  const [sessionPaths, setSessionPaths] = useState<ReadonlySet<string> | null>(null);
  const ws = useStore((s) => s.activeWorkspaceId);
  const chatTab = useStore((s) => activeTab(s.tabs));
  // The changes filter follows the chat tab in front, when it works in this workspace.
  const sessionId = (chatTab.ws || "") === (ws || "") ? chatTab.chat.sessionId : null;
  const requests = useWorkspaceAsyncCoordinator(ws, () => useStore.getState().activeWorkspaceId);
  const writes = useRef(new ExclusiveOperation());

  const refresh = useCallback(
    async (opts: { keepError?: boolean } = {}) => {
      const request = requests.beginLatest(ws);
      if (!request) return;
      if (!opts.keepError) setError(null);
      setLoading(true);
      try {
        const [res, status] = await Promise.all([
          api.diff(staged, request.workspaceId),
          staged ? Promise.resolve(null) : api.gitStatus(request.workspaceId).catch(() => null),
        ]);
        if (!requests.isCurrent(request)) return;
        setFiles(splitDiffByFile(res.diff));
        setTruncated(res.truncated);
        setNotGit(res.notGit ?? false);
        setUntracked(status?.files.filter((f) => f.status === "untracked").map((f) => f.path) ?? []);
      } catch (err) {
        if (!requests.isCurrent(request)) return;
        setError(err instanceof Error ? err.message : String(err));
        setFiles(null);
      } finally {
        if (requests.isCurrent(request)) setLoading(false);
      }
    },
    [requests, staged, ws],
  );
  // A mutation that finishes after the view changed mode reloads the current mode.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    writes.current.invalidate();
    setFiles(null);
    setUntracked([]);
    setTruncated(false);
    setNotGit(false);
    setBusy(false);
    setConfirm(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (scope !== "session" || !sessionId) {
      setSessionPaths(null);
      return;
    }
    const request = requests.capture(ws);
    if (!request) return;
    let alive = true;
    api
      .sessionChanges(sessionId, request.workspaceId)
      .then((r) => {
        if (alive && requests.isCurrent(request)) setSessionPaths(new Set(r.files));
      })
      .catch((e: unknown) => {
        if (alive && requests.isCurrent(request)) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [requests, scope, sessionId, ws]);

  const mutate = (fn: (workspaceId: string) => Promise<unknown>) => {
    const mutation = requests.capture(ws);
    if (!mutation) return;
    const write = writes.current.begin();
    if (!write) return;
    setBusy(true);
    setError(null);
    Promise.resolve()
      .then(() => fn(mutation.workspaceId))
      .then(
        () => false,
        (e: unknown) => {
          if (requests.isCurrent(mutation)) setError(e instanceof Error ? e.message : String(e));
          return true;
        },
      )
      .then((failed) => (requests.isCurrent(mutation) ? refreshRef.current({ keepError: failed }) : undefined))
      .finally(() => {
        if (writes.current.end(write) && requests.isCurrent(mutation)) setBusy(false);
      });
  };

  const onFileAction = (path: string, action: FileAction) => {
    if (action === "revert") setConfirm({ kind: "revertFile", path });
    else mutate((w) => (action === "stage" ? api.gitStage([path], w) : api.gitUnstage([path], w)));
  };
  const onHunkAction = (path: string, hunk: string, action: GitHunkAction) => {
    if (action === "revert") setConfirm({ kind: "revertHunk", path, hunk });
    else mutate((w) => api.gitHunk(path, hunk, action, w));
  };
  const runConfirmed = () => {
    const pending = confirm;
    setConfirm(null);
    if (!pending) return;
    if (pending.kind === "revertHunk") mutate((w) => api.gitHunk(pending.path, pending.hunk, "revert", w));
    // /api/git/discard restores tracked paths and deletes untracked ones.
    else mutate((w) => api.gitDiscard([pending.path], w));
  };

  const filterPaths = scope === "session" ? sessionPaths : null;
  const visible = files ? filterToPaths(files, filterPaths) : null;
  const visibleUntracked = staged
    ? []
    : filterToPaths(
        untracked.map((path) => ({ path })),
        filterPaths,
      ).map((entry) => entry.path);
  const totals = visible ? diffTotals(visible) : null;
  const hasChanges = !!totals && (totals.files > 0 || visibleUntracked.length > 0);

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Header bar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-subtle px-6 py-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-muted text-accent-hover">
            <IconDiff size={16} />
          </span>
          <h1 className="text-lg font-semibold text-primary">{t("diff.title")}</h1>
        </div>

        {totals && totals.files > 0 && (
          <span className="flex items-center gap-2 font-mono text-xs text-tertiary">
            {t("diff.fileCount", { count: totals.files })}
            <span className="text-ok">+{totals.additions}</span>
            <span className="text-danger">-{totals.deletions}</span>
          </span>
        )}

        {truncated && <Badge tone="warn">{t("diff.truncated")}</Badge>}

        <div className="ml-auto flex flex-wrap items-center gap-3">
          <Select
            size="sm"
            value={scope}
            onChange={(value) => setScope(value as "all" | "session")}
            ariaLabel={t("diff.scopeLabel")}
            title={sessionId ? t("diff.scopeLabel") : t("diff.scopeNoSession")}
            options={[
              { value: "all", label: t("diff.scopeAll") },
              ...(sessionId ? [{ value: "session", label: t("diff.scopeSession") }] : []),
            ]}
          />
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-secondary">
            <input
              type="checkbox"
              checked={staged}
              onChange={(e) => setStaged(e.target.checked)}
              className="accent-accent"
            />
            {t("diff.staged")}
          </label>
          <Button variant="ghost" size="sm" onClick={() => void refresh()}>
            {t("diff.refresh")}
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 space-y-4 overflow-auto px-6 py-5">
        {error && (
          <div className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>
        )}

        {loading && files === null && <p className="text-sm text-tertiary">{t("diff.loading")}</p>}

        {!loading && notGit && (
          <EmptyState
            icon={<IconDiff size={28} />}
            title={t("diff.notGitTitle")}
            description={t("diff.notGitDescription")}
          />
        )}

        {!loading && !notGit && visible && !hasChanges && (
          <EmptyState
            icon={<IconDiff size={28} />}
            title={scope === "session" ? t("diff.emptySessionTitle") : t("diff.emptyTitle")}
            description={t("diff.emptyDescription")}
          />
        )}

        {/* Per-file diff cards */}
        {visible?.map((f) => (
          <FileSection
            key={f.path}
            file={f}
            staged={staged}
            busy={busy}
            onFileAction={onFileAction}
            onHunkAction={onHunkAction}
          />
        ))}

        {visibleUntracked.length > 0 && (
          <Card flush className="overflow-hidden">
            <div className="px-4 py-2.5 text-2xs uppercase tracking-wider text-tertiary">
              {t("diff.untrackedSection", { count: visibleUntracked.length })}
            </div>
            <ul className="divide-y divide-subtle/60 border-t border-subtle">
              {visibleUntracked.map((path) => (
                <li key={path} className="flex items-center gap-2 px-4 py-1.5">
                  <Badge tone="ok">{t("diff.newFile")}</Badge>
                  <button
                    type="button"
                    onClick={() => useStore.getState().openFileAt(path)}
                    className="min-w-0 flex-1 truncate text-left font-mono text-xs text-secondary hover:text-primary"
                  >
                    {path}
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    className="hover:text-danger"
                    onClick={() => setConfirm({ kind: "deleteUntracked", path })}
                  >
                    {t("diff.deleteUntracked")}
                  </Button>
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => onFileAction(path, "stage")}>
                    {t("diff.stageFile")}
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {/* Validation suggestion card */}
        {hasChanges && (
          <Card className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-muted text-accent-hover">
                <IconSparkle size={16} />
              </span>
              <p className="text-sm text-secondary">{t("chat.home.action.runTestsTask")}</p>
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                const s = useStore.getState();
                s.setView("chat");
                s.sendTask(t("chat.home.action.runTestsTask"));
              }}
            >
              {t("chat.home.action.runTests")}
            </Button>
          </Card>
        )}
      </div>

      {confirm && (
        <ConfirmDialog
          title={
            confirm.kind === "deleteUntracked"
              ? t("diff.deleteUntrackedTitle")
              : confirm.kind === "revertHunk"
                ? t("diff.revertHunkTitle")
                : t("diff.revertFileTitle")
          }
          confirmLabel={confirm.kind === "deleteUntracked" ? t("diff.deleteUntracked") : t("diff.revertConfirm")}
          danger
          onConfirm={runConfirmed}
          onCancel={() => setConfirm(null)}
        >
          <p>
            {confirm.kind === "deleteUntracked"
              ? t("diff.deleteUntrackedBody", { path: confirm.path })
              : confirm.kind === "revertHunk"
                ? t("diff.revertHunkBody", { path: confirm.path })
                : t("diff.revertFileBody", { path: confirm.path })}
          </p>
          {confirm.kind === "revertHunk" && (
            <div className="mt-2">
              <DiffBlock diff={confirm.hunk} lang={langFromPath(confirm.path)} />
            </div>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
