import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { diffTotals, splitDiffByFile, type FileDiff } from "../lib/diff-files";
import { DiffBlock } from "../components/DiffBlock";

function FileSection({ file }: { file: FileDiff }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded border border-zinc-800">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 bg-zinc-900/60 px-3 py-1.5 text-left font-mono text-xs"
      >
        <span className="text-zinc-500">{open ? "▾" : "▸"}</span>
        <span className="flex-1 truncate text-zinc-200">{file.path}</span>
        <span className="text-emerald-400">+{file.additions}</span>
        <span className="text-red-400">-{file.deletions}</span>
      </button>
      {open && <DiffBlock diff={file.text} />}
    </div>
  );
}

export function DiffView() {
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const [staged, setStaged] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ws = useStore((s) => s.activeWorkspaceId);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await api.diff(staged);
      setFiles(splitDiffByFile(res.diff));
      setTruncated(res.truncated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setFiles(null);
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
        <h1 className="text-sm font-semibold text-zinc-200">Workspace diff</h1>
        <label className="flex items-center gap-1.5 text-xs text-zinc-400">
          <input type="checkbox" checked={staged} onChange={(e) => setStaged(e.target.checked)} />
          staged
        </label>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          refresh
        </button>
        {totals && totals.files > 0 && (
          <span className="font-mono text-xs text-zinc-500">
            {totals.files} file(s) <span className="text-emerald-400">+{totals.additions}</span>{" "}
            <span className="text-red-400">-{totals.deletions}</span>
          </span>
        )}
        {truncated && <span className="text-xs text-amber-400">diff truncated (2 MB cap)</span>}
      </div>

      {error && (
        <div className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-200">{error}</div>
      )}
      {files && files.length === 0 && !error && (
        <div className="text-sm text-zinc-500">Working tree clean — no changes.</div>
      )}
      <div className="flex-1 space-y-3 overflow-auto">
        {files?.map((f) => <FileSection key={f.path} file={f} />)}
      </div>
    </div>
  );
}
