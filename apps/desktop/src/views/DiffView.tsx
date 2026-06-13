import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { diffTotals, splitDiffByFile, type FileDiff } from "../lib/diff-files";
import { DiffBlock } from "../components/DiffBlock";
import { Button, EmptyState, IconChevron, IconDiff } from "../components/ui";

function FileSection({ file }: { file: FileDiff }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="overflow-hidden rounded-lg border border-subtle">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="focus-ring flex w-full items-center gap-2 bg-surface-raised/60 px-3 py-1.5 text-left font-mono text-xs hover:bg-surface-overlay"
      >
        <span className="text-tertiary"><IconChevron size={10} className={open ? 'rotate-90' : ''} /></span>
        <span className="flex-1 truncate text-primary">{file.path}</span>
        <span className="text-ok">+{file.additions}</span>
        <span className="text-danger">-{file.deletions}</span>
      </button>
      {open && <DiffBlock diff={file.text} />}
    </div>
  );
}

export function DiffView() {
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [staged, setStaged] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ws = useStore((s) => s.activeWorkspaceId);

  const refresh = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await api.diff(staged);
      setFiles(splitDiffByFile(res.diff));
      setTruncated(res.truncated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setFiles(null);
    } finally {
      setLoading(false);
    }
    // `ws` is read from the store closure by api.diff; it is a dep so the diff
    // refreshes when the active workspace changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staged, ws]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const totals = files ? diffTotals(files) : null;

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <h1 className="text-sm font-semibold text-primary">Workspace diff</h1>
        <label className="flex items-center gap-1.5 text-xs text-secondary">
          <input type="checkbox" checked={staged} onChange={(e) => setStaged(e.target.checked)} className="accent-accent" />
          staged
        </label>
        <Button variant="ghost" size="sm" onClick={() => void refresh()}>
          refresh
        </Button>
        {totals && totals.files > 0 && (
          <span className="font-mono text-xs text-tertiary">
            {totals.files} file(s) <span className="text-ok">+{totals.additions}</span>{" "}
            <span className="text-danger">-{totals.deletions}</span>
          </span>
        )}
        {truncated && <span className="text-xs text-warn">diff truncated (2 MB cap)</span>}
      </div>

      {error && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>
      )}
      {!error && loading && files === null && <p className="text-sm text-tertiary">Loading…</p>}
      {!error && !loading && files && files.length === 0 && (
        <EmptyState icon={<IconDiff size={28} />} title="Working tree clean" description="No uncommitted changes." />
      )}
      <div className="flex-1 space-y-3 overflow-auto">
        {files?.map((f) => <FileSection key={f.path} file={f} />)}
      </div>
    </div>
  );
}
