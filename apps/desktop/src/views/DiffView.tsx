import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { diffTotals, splitDiffByFile, type FileDiff } from "../lib/diff-files";
import { DiffBlock } from "../components/DiffBlock";
import { useT } from "../lib/i18n";
import { Badge, Button, Card, EmptyState, IconChevron, IconDiff, IconSparkle } from "../components/ui";
import { useWorkspaceAsyncCoordinator } from "./use-workspace-async";

function FileSection({ file }: { file: FileDiff }) {
  const t = useT();
  const [open, setOpen] = useState(true);
  return (
    <Card flush className="overflow-hidden">
      <div className="flex w-full items-center gap-2.5 px-4 py-2.5 hover:bg-surface-overlay/60">
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
      </div>
      {open && (
        <div className="px-3 pb-3">
          <DiffBlock diff={file.text} />
        </div>
      )}
    </Card>
  );
}

export function DiffView() {
  const t = useT();
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [staged, setStaged] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [notGit, setNotGit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ws = useStore((s) => s.activeWorkspaceId);
  const requests = useWorkspaceAsyncCoordinator(ws, () => useStore.getState().activeWorkspaceId);

  const refresh = useCallback(async () => {
    const request = requests.beginLatest(ws);
    if (!request) return;
    setError(null);
    setLoading(true);
    try {
      const res = await api.diff(staged);
      if (!requests.isCurrent(request)) return;
      setFiles(splitDiffByFile(res.diff));
      setTruncated(res.truncated);
      setNotGit(res.notGit ?? false);
    } catch (err) {
      if (!requests.isCurrent(request)) return;
      setError(err instanceof Error ? err.message : String(err));
      setFiles(null);
    } finally {
      if (requests.isCurrent(request)) setLoading(false);
    }
  }, [requests, staged, ws]);

  useEffect(() => {
    setFiles(null);
    setTruncated(false);
    setNotGit(false);
    void refresh();
  }, [refresh]);

  const totals = files ? diffTotals(files) : null;
  const hasChanges = !!totals && totals.files > 0;

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

        {hasChanges && (
          <span className="flex items-center gap-2 font-mono text-xs text-tertiary">
            {t("diff.fileCount", { count: totals.files })}
            <span className="text-ok">+{totals.additions}</span>
            <span className="text-danger">-{totals.deletions}</span>
          </span>
        )}

        {truncated && <Badge tone="warn">{t("diff.truncated")}</Badge>}

        <div className="ml-auto flex items-center gap-3">
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

        {!error && loading && files === null && <p className="text-sm text-tertiary">{t("diff.loading")}</p>}

        {!error && !loading && notGit && (
          <EmptyState
            icon={<IconDiff size={28} />}
            title={t("diff.notGitTitle")}
            description={t("diff.notGitDescription")}
          />
        )}

        {!error && !loading && !notGit && files && files.length === 0 && (
          <EmptyState
            icon={<IconDiff size={28} />}
            title={t("diff.emptyTitle")}
            description={t("diff.emptyDescription")}
          />
        )}

        {/* Summary card */}
        {hasChanges && (
          <Card className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-muted text-accent-hover">
              <IconSparkle size={16} />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-primary">{t("diff.title")}</p>
              <p className="mt-0.5 font-mono text-xs text-secondary">
                {t("diff.fileCount", { count: totals.files })} <span className="text-ok">+{totals.additions}</span>{" "}
                <span className="text-danger">-{totals.deletions}</span>
              </p>
            </div>
          </Card>
        )}

        {/* Per-file diff cards */}
        {files?.map((f) => (
          <FileSection key={f.path} file={f} />
        ))}

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
    </div>
  );
}
