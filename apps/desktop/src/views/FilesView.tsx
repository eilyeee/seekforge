import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { Markdown } from "../components/Markdown";
import { CodeEditor, type CodeEditorHandle } from "../components/CodeEditor";
import { Modal } from "../components/ui/Modal";
import { useT } from "../lib/i18n";
import { Badge, Button, EmptyState, IconChevron, IconFiles, IconSearch, Input } from "../components/ui";
import type { FileContent, SearchResult, TreeEntry } from "../types";

/** A directory node in the lazy-loaded tree: its children + load/expand state. */
type DirState = {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  entries: TreeEntry[];
};

export function FilesView() {
  const t = useT();
  const ws = useStore((s) => s.activeWorkspaceId);
  const wsPath = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.path ?? "");

  // Per-directory listing cache keyed by relative path ("" = root).
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedLine, setSelectedLine] = useState<number | undefined>(undefined);
  const [leftMode, setLeftMode] = useState<"tree" | "search">("tree");
  const [finderOpen, setFinderOpen] = useState(false);

  const openFile = (path: string, line?: number) => {
    setSelected(path);
    setSelectedLine(line);
  };

  const loadDir = (path: string) => {
    setDirs((d) => ({ ...d, [path]: { loaded: false, loading: true, error: null, entries: [] } }));
    api
      .tree(path || undefined)
      .then((res) =>
        setDirs((d) => ({ ...d, [path]: { loaded: true, loading: false, error: null, entries: res.entries } })),
      )
      .catch((e: unknown) =>
        setDirs((d) => ({
          ...d,
          [path]: { loaded: true, loading: false, error: String(e), entries: [] },
        })),
      );
  };

  // (Re)load the root whenever the workspace changes; reset all state.
  useEffect(() => {
    setDirs({});
    setExpanded(new Set());
    setSelected(null);
    setSelectedLine(undefined);
    setLeftMode("tree");
    setFinderOpen(false);
    loadDir("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  // ⌘/Ctrl+P opens the fuzzy "go to file" finder.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        setFinderOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleDir = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (!dirs[path]?.loaded && !dirs[path]?.loading) loadDir(path);
      }
      return next;
    });
  };

  const root = dirs[""];

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-subtle px-6 py-4">
        <h1 className="text-lg font-semibold text-primary">{t("files.title")}</h1>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-tertiary">{t("files.description")}</p>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-subtle">
          <div className="flex items-center gap-1 border-b border-subtle px-2 py-1.5">
            <Button
              size="sm"
              variant={leftMode === "tree" ? "primary" : "ghost"}
              onClick={() => setLeftMode("tree")}
            >
              {t("files.tabTree")}
            </Button>
            <Button
              size="sm"
              variant={leftMode === "search" ? "primary" : "ghost"}
              onClick={() => setLeftMode("search")}
            >
              {t("files.tabSearch")}
            </Button>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => setFinderOpen(true)} title={t("files.goToFileTitle")}>
              {t("files.goToFile")}
            </Button>
          </div>

          {leftMode === "search" ? (
            <SearchPanel onOpen={openFile} />
          ) : (
            <div className="flex-1 overflow-y-auto py-2">
              {root === undefined || (root.loading && !root.loaded) ? (
                <p className="px-4 py-2 text-xs text-tertiary">{t("files.treeLoading")}</p>
              ) : root.error ? (
                <p className="px-4 py-2 text-xs text-danger">{t("files.treeError", { error: root.error })}</p>
              ) : root.entries.length === 0 ? (
                <p className="px-4 py-2 text-xs text-tertiary">{t("files.treeEmpty")}</p>
              ) : (
                <ul>
                  {root.entries.map((e) => (
                    <TreeNode
                      key={e.path}
                      entry={e}
                      depth={0}
                      dirs={dirs}
                      expanded={expanded}
                      selected={selected}
                      onToggle={toggleDir}
                      onSelect={(p) => openFile(p)}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
        </aside>

        <section className="min-w-0 flex-1 overflow-hidden">
          {selected === null ? (
            <EmptyState
              icon={<IconFiles size={28} />}
              title={t("files.noSelection")}
              description={t("files.noSelectionHint")}
            />
          ) : (
            <FilePane key={selected} path={selected} initialLine={selectedLine} wsPath={wsPath} />
          )}
        </section>
      </div>

      {finderOpen && (
        <FileFinder
          onClose={() => setFinderOpen(false)}
          onPick={(p) => {
            openFile(p);
            setFinderOpen(false);
          }}
        />
      )}
    </div>
  );
}

/** Project-wide content search results (GET /api/search), debounced. */
function SearchPanel({ onOpen }: { onOpen: (path: string, line: number) => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [res, setRes] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term === "") {
      setRes(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const h = window.setTimeout(() => {
      api
        .searchContent(term)
        .then(setRes)
        .catch(() => setRes({ hits: [], truncated: false }))
        .finally(() => setLoading(false));
    }, 250);
    return () => window.clearTimeout(h);
  }, [q]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="p-2">
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("files.searchPlaceholder")} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p className="px-4 py-2 text-xs text-tertiary">{t("files.searching")}</p>
        ) : res === null ? (
          <p className="px-4 py-2 text-xs text-tertiary">{t("files.searchHint")}</p>
        ) : res.hits.length === 0 ? (
          <p className="px-4 py-2 text-xs text-tertiary">{t("files.searchNoResults")}</p>
        ) : (
          <ul>
            {res.hits.map((h, i) => (
              <li key={`${h.path}:${h.line}:${i}`}>
                <button
                  type="button"
                  onClick={() => onOpen(h.path, h.line)}
                  className="block w-full px-3 py-1.5 text-left hover:bg-surface-overlay"
                >
                  <span className="block truncate font-mono text-2xs text-tertiary">
                    {h.path}:{h.line}
                  </span>
                  <span className="block truncate font-mono text-xs text-secondary">{h.text.trim()}</span>
                </button>
              </li>
            ))}
            {res.truncated && <li className="px-3 py-1.5 text-2xs text-tertiary">{t("files.searchTruncated")}</li>}
          </ul>
        )}
      </div>
    </div>
  );
}

/** ⌘P fuzzy "go to file" finder over the ignore-aware file index. */
function FileFinder({ onClose, onPick }: { onClose: () => void; onPick: (path: string) => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [files, setFiles] = useState<string[]>([]);

  useEffect(() => {
    const h = window.setTimeout(() => {
      api
        .files(q.trim())
        .then((r) => setFiles(r.files))
        .catch(() => setFiles([]));
    }, 120);
    return () => window.clearTimeout(h);
  }, [q]);

  const shown = files.slice(0, 50);

  return (
    <Modal title={t("files.goToFile")} onDismiss={onClose}>
      <Input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && shown[0]) onPick(shown[0]);
        }}
        placeholder={t("files.goToFilePlaceholder")}
        className="font-mono"
      />
      <ul className="mt-2 max-h-80 overflow-y-auto">
        {shown.length === 0 ? (
          <li className="px-1 py-2 text-xs text-tertiary">{t("files.searchNoResults")}</li>
        ) : (
          shown.map((f) => (
            <li key={f}>
              <button
                type="button"
                onClick={() => onPick(f)}
                className="block w-full truncate rounded px-2 py-1 text-left font-mono text-xs text-secondary hover:bg-surface-overlay hover:text-primary"
              >
                {f}
              </button>
            </li>
          ))
        )}
      </ul>
    </Modal>
  );
}

/** One row in the tree; directories recurse into their cached children. */
function TreeNode({
  entry,
  depth,
  dirs,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  entry: TreeEntry;
  depth: number;
  dirs: Record<string, DirState>;
  expanded: Set<string>;
  selected: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const t = useT();
  const isDir = entry.type === "dir";
  const isOpen = expanded.has(entry.path);
  const child = dirs[entry.path];
  const isSelected = !isDir && selected === entry.path;
  const pad = { paddingLeft: `${depth * 14 + 12}px` };

  return (
    <li>
      <button
        type="button"
        onClick={() => (isDir ? onToggle(entry.path) : onSelect(entry.path))}
        aria-current={isSelected ? "true" : undefined}
        aria-expanded={isDir ? isOpen : undefined}
        style={pad}
        className={`flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs transition-colors ${
          isSelected
            ? "bg-accent-muted font-medium text-accent"
            : "text-secondary hover:bg-surface-overlay hover:text-primary"
        }`}
      >
        {isDir ? (
          <IconChevron size={12} className={`shrink-0 text-tertiary ${isOpen ? "rotate-90" : ""}`} />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="truncate font-mono">{entry.name}</span>
      </button>

      {isDir && isOpen && (
        <ul>
          {child === undefined || child.loading ? (
            <li style={{ paddingLeft: `${(depth + 1) * 14 + 12}px` }} className="py-1 text-2xs text-tertiary">
              {t("files.treeLoading")}
            </li>
          ) : child.error ? (
            <li
              style={{ paddingLeft: `${(depth + 1) * 14 + 12}px` }}
              className="py-1 text-2xs text-danger"
            >
              {t("files.treeError", { error: child.error })}
            </li>
          ) : child.entries.length === 0 ? (
            <li
              style={{ paddingLeft: `${(depth + 1) * 14 + 12}px` }}
              className="py-1 text-2xs text-tertiary"
            >
              {t("files.treeEmpty")}
            </li>
          ) : (
            child.entries.map((e) => (
              <TreeNode
                key={e.path}
                entry={e}
                depth={depth + 1}
                dirs={dirs}
                expanded={expanded}
                selected={selected}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))
          )}
        </ul>
      )}
    </li>
  );
}

const MARKDOWN_RE = /\.(md|markdown)$/i;

/** Views one file with an Edit/Save toggle (PUT /api/file). */
function FilePane({ path, initialLine, wsPath }: { path: string; initialLine?: number; wsPath: string }) {
  const t = useT();
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<"rel" | "abs" | null>(null);
  const [viewSource, setViewSource] = useState(false);
  const [wrap, setWrap] = useState(false);
  const editorRef = useRef<CodeEditorHandle>(null);

  useEffect(() => {
    setFile(null);
    setError(null);
    setEditing(false);
    setSaveError(null);
    setSaved(false);
    api
      .readFile(path)
      .then((f) => {
        setFile(f);
        setDraft(f.content);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [path]);

  const startEdit = () => {
    if (!file) return;
    setDraft(file.content);
    setSaveError(null);
    setSaved(false);
    setEditing(true);
  };

  const save = () => {
    setSaving(true);
    setSaveError(null);
    api
      .writeFile(path, draft)
      .then(() => {
        setFile((f) => (f ? { ...f, content: draft } : f));
        setEditing(false);
        setSaved(true);
      })
      .catch((e: unknown) => setSaveError(String(e)))
      .finally(() => setSaving(false));
  };

  const isMarkdown = MARKDOWN_RE.test(path);
  // A CodeMirror instance is mounted while editing, or when viewing any
  // non-markdown file, or when viewing markdown source — i.e. not the rendered
  // Markdown. Find / wrap apply only then.
  const showRenderedMarkdown = !!file && !editing && isMarkdown && !viewSource;
  const editorShown = !!file && !showRenderedMarkdown;

  const flashCopied = (which: "rel" | "abs") => {
    setCopied(which);
    window.setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500);
  };
  const copyRel = () => void navigator.clipboard.writeText(path).then(() => flashCopied("rel"), () => {});
  const absPath = wsPath ? `${wsPath.replace(/\/$/, "")}/${path}` : path;
  const copyAbs = () => void navigator.clipboard.writeText(absPath).then(() => flashCopied("abs"), () => {});

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-subtle px-4 py-2">
        <button
          type="button"
          onClick={copyRel}
          title={t("files.copyPathTitle")}
          className="min-w-0 flex-1 truncate text-left font-mono text-xs text-secondary hover:text-primary"
        >
          {path}
        </button>
        {copied && <span className="text-2xs text-ok">{t("files.copied")}</span>}
        {file?.truncated && <Badge tone="warn">{t("files.truncated")}</Badge>}
        {saved && !editing && <span className="text-2xs text-ok">{t("files.saved")}</span>}
        <Button size="sm" variant="ghost" onClick={copyRel} title={t("files.copyPathTitle")}>
          {t("files.copyPath")}
        </Button>
        <Button size="sm" variant="ghost" onClick={copyAbs} title={t("files.copyAbsTitle")}>
          {t("files.copyAbs")}
        </Button>
        {file && !editing && isMarkdown && (
          <Button size="sm" variant="ghost" onClick={() => setViewSource((v) => !v)}>
            {viewSource ? t("files.viewRendered") : t("files.viewSource")}
          </Button>
        )}
        {editorShown && (
          <Button
            size="sm"
            variant={wrap ? "primary" : "ghost"}
            onClick={() => setWrap((w) => !w)}
            title={t("files.wrapTitle")}
          >
            {t("files.wrap")}
          </Button>
        )}
        {editorShown && (
          <Button size="sm" variant="ghost" onClick={() => editorRef.current?.openSearch()} title={t("files.findTitle")}>
            <IconSearch size={13} />
            {t("files.find")}
          </Button>
        )}
        {file && !editing && (
          <Button size="sm" onClick={startEdit} disabled={file.truncated}>
            {t("files.edit")}
          </Button>
        )}
        {editing && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
              {t("files.cancel")}
            </Button>
            <Button size="sm" variant="primary" onClick={save} disabled={saving}>
              {saving ? t("files.saving") : t("files.save")}
            </Button>
          </>
        )}
      </div>

      {saveError && (
        <div className="border-b border-danger/40 bg-danger/10 px-4 py-1.5 text-xs text-danger">
          {t("files.saveError", { error: saveError })}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <p className="px-4 py-4 text-xs text-danger">{t("files.loadError", { error })}</p>
        ) : file === null ? (
          <p className="px-4 py-4 text-xs text-tertiary">{t("files.loading")}</p>
        ) : editing ? (
          <CodeEditor ref={editorRef} path={path} value={draft} onChange={setDraft} wrap={wrap} />
        ) : showRenderedMarkdown ? (
          <div className="px-4 py-3 text-sm leading-relaxed text-secondary">
            <Markdown source={file.content} />
          </div>
        ) : (
          <CodeEditor
            ref={editorRef}
            path={path}
            value={file.content}
            onChange={() => {}}
            readOnly
            wrap={wrap}
            scrollToLine={initialLine}
          />
        )}
      </div>
    </div>
  );
}
