import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { Markdown } from "../components/Markdown";
import type { CodeEditorHandle } from "../components/CodeEditor";
// CodeMirror + its 16 language packages are heavy and only needed here, so the
// editor is a lazily-loaded chunk (kept out of the initial bundle).
const CodeEditor = lazy(() => import("../components/CodeEditor").then((m) => ({ default: m.CodeEditor })));
import { Modal } from "../components/ui/Modal";
import { fuzzyRank } from "../lib/fuzzy";
import { useT } from "../lib/i18n";
import { Badge, Button, EmptyState, IconChevron, IconFiles, IconSearch, Input } from "../components/ui";
import type { FileContent, SearchHit, SearchResult, TreeEntry } from "../types";
import { useWorkspaceAsyncCoordinator } from "./use-workspace-async";

/** A reveal target passed to the editor (1-based line + match span + nonce). */
type Reveal = { line: number; col: number; len: number; nonce: number };

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
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [leftMode, setLeftMode] = useState<"tree" | "search">("tree");
  // The finder is openable globally (⌘P), so its open state lives in the store.
  const finderOpen = useStore((s) => s.filesFinderOpen);
  const setFinderOpen = useStore((s) => s.setFilesFinderOpen);
  // A cross-view "open this file at a line" request (chat / diff / git links).
  const filesTarget = useStore((s) => s.filesTarget);
  const clearFilesTarget = useStore((s) => s.clearFilesTarget);
  const requests = useWorkspaceAsyncCoordinator(ws, () => useStore.getState().activeWorkspaceId);

  const openFile = (path: string, hit?: { line: number; col: number; len: number }) => {
    setSelected(path);
    setReveal(hit ? { ...hit, nonce: Date.now() } : null);
    setRecent((r) => [path, ...r.filter((p) => p !== path)].slice(0, 20));
  };

  const loadDir = (path: string) => {
    const request = requests.capture(ws);
    if (!request) return;
    setDirs((d) => ({ ...d, [path]: { loaded: false, loading: true, error: null, entries: [] } }));
    api
      .tree(path || undefined)
      .then((res) => {
        if (!requests.isCurrent(request)) return;
        setDirs((d) => ({ ...d, [path]: { loaded: true, loading: false, error: null, entries: res.entries } }));
      })
      .catch((e: unknown) => {
        if (!requests.isCurrent(request)) return;
        setDirs((d) => ({
          ...d,
          [path]: { loaded: true, loading: false, error: String(e), entries: [] },
        }));
      });
  };

  // (Re)load the root whenever the workspace changes; reset all state.
  useEffect(() => {
    setDirs({});
    setExpanded(new Set());
    setSelected(null);
    setReveal(null);
    setRecent([]);
    setLeftMode("tree");
    // NB: don't reset finderOpen here — a global ⌘P sets it just before this
    // view mounts, and clearing it on mount would immediately close the finder.
    loadDir("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests]);

  // Honor a cross-view "open file at line" request (chat / diff / git links).
  // It's a one-shot intent: consume then clear, so it doesn't re-fire when this
  // view later remounts.
  useEffect(() => {
    if (!filesTarget) return;
    openFile(
      filesTarget.path,
      filesTarget.line !== undefined
        ? { line: filesTarget.line, col: filesTarget.col ?? 0, len: filesTarget.len ?? 0 }
        : undefined,
    );
    clearFilesTarget();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesTarget?.nonce]);


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
            <SearchPanel key={ws} onOpen={openFile} />
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
            <FilePane key={`${ws}:${selected}`} path={selected} reveal={reveal} wsPath={wsPath} />
          )}
        </section>
      </div>

      {finderOpen && (
        <FileFinder
          key={ws}
          recent={recent}
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

/** Renders `text` with the [col, col+len) span emphasized. */
function HitLine({ text, col, len }: { text: string; col: number; len: number }) {
  if (len <= 0 || col < 0) return <>{text.trim() || text}</>;
  const a = text.slice(0, col);
  const b = text.slice(col, col + len);
  const c = text.slice(col + len);
  return (
    <>
      {a}
      <mark className="rounded bg-accent-muted px-0.5 text-accent-hover">{b}</mark>
      {c}
    </>
  );
}

/** Project-wide content search (GET /api/search): debounced, grouped by file. */
function SearchPanel({ onOpen }: { onOpen: (path: string, hit: SearchHit) => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [res, setRes] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    // Bump the token first so any in-flight request is invalidated even when the
    // box is cleared — otherwise a slow prior response repopulates an empty box.
    const mine = ++seq.current;
    if (term === "") {
      setRes(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const h = window.setTimeout(() => {
      api
        .searchContent(term, { caseSensitive, regex })
        .then((r) => {
          if (mine === seq.current) setRes(r); // ignore out-of-order responses
        })
        .catch(() => {
          if (mine === seq.current) setRes({ hits: [], truncated: false });
        })
        .finally(() => {
          if (mine === seq.current) setLoading(false);
        });
    }, 250);
    return () => window.clearTimeout(h);
  }, [q, caseSensitive, regex]);

  // Group hits by file, preserving first-seen order.
  const groups: { path: string; hits: SearchHit[] }[] = [];
  if (res) {
    const byPath = new Map<string, SearchHit[]>();
    for (const h of res.hits) {
      const list = byPath.get(h.path);
      if (list) list.push(h);
      else {
        const fresh = [h];
        byPath.set(h.path, fresh);
        groups.push({ path: h.path, hits: fresh });
      }
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1.5 p-2">
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("files.searchPlaceholder")} />
        <div className="flex items-center gap-1">
          <Button size="sm" variant={caseSensitive ? "primary" : "ghost"} onClick={() => setCaseSensitive((v) => !v)} title={t("files.searchCaseTitle")}>
            Aa
          </Button>
          <Button size="sm" variant={regex ? "primary" : "ghost"} onClick={() => setRegex((v) => !v)} title={t("files.searchRegexTitle")}>
            .*
          </Button>
          {res && res.hits.length > 0 && (
            <span className="ml-auto text-2xs text-tertiary">
              {t("files.searchCount", { hits: res.hits.length, files: groups.length })}
            </span>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p className="px-4 py-2 text-xs text-tertiary">{t("files.searching")}</p>
        ) : res === null ? (
          <p className="px-4 py-2 text-xs text-tertiary">{t("files.searchHint")}</p>
        ) : res.error ? (
          <p className="px-4 py-2 text-xs text-danger">{t("files.searchInvalidRegex")}</p>
        ) : res.hits.length === 0 ? (
          <p className="px-4 py-2 text-xs text-tertiary">{t("files.searchNoResults")}</p>
        ) : (
          <ul className="pb-2">
            {groups.map((g) => (
              <li key={g.path}>
                <div className="sticky top-0 truncate bg-surface px-3 py-1 font-mono text-2xs text-tertiary">
                  {g.path} <span className="text-tertiary/70">({g.hits.length})</span>
                </div>
                {g.hits.map((h, i) => (
                  <button
                    key={`${h.line}:${h.col}:${i}`}
                    type="button"
                    onClick={() => onOpen(h.path, h)}
                    className="block w-full px-3 py-1 text-left hover:bg-surface-overlay"
                  >
                    <span className="flex gap-2 font-mono text-xs">
                      <span className="shrink-0 text-tertiary">{h.line}</span>
                      <span className="truncate text-secondary">
                        <HitLine text={h.text} col={h.col} len={h.len} />
                      </span>
                    </span>
                  </button>
                ))}
              </li>
            ))}
            {res.truncated && <li className="px-3 py-1.5 text-2xs text-tertiary">{t("files.searchTruncated")}</li>}
          </ul>
        )}
      </div>
    </div>
  );
}

/** ⌘P fuzzy "go to file" finder: loads the file index once, ranks client-side. */
function FileFinder({
  recent,
  onClose,
  onPick,
}: {
  recent: string[];
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    api
      .files("")
      .then((r) => setFiles(r.files))
      .catch(() => setFiles([]));
  }, []);

  const term = q.trim();
  // Empty query → recent first (then the index); otherwise fuzzy-rank the index.
  const shown: { path: string; positions: number[] }[] =
    term === ""
      ? [...recent.filter((p) => files.includes(p)), ...files.filter((f) => !recent.includes(f))]
          .slice(0, 50)
          .map((path) => ({ path, positions: [] }))
      : fuzzyRank(term, files, (f) => f)
          .slice(0, 50)
          .map((r) => ({ path: r.item, positions: r.match.positions }));

  useEffect(() => setActive(0), [q]);
  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    itemRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (i: number) => {
    if (shown[i]) onPick(shown[i].path);
  };

  return (
    <Modal title={t("files.goToFile")} onDismiss={onClose}>
      <Input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, shown.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(active);
          }
        }}
        placeholder={t("files.goToFilePlaceholder")}
        className="font-mono"
      />
      <ul className="mt-2 max-h-80 overflow-y-auto">
        {shown.length === 0 ? (
          <li className="px-1 py-2 text-xs text-tertiary">{t("files.searchNoResults")}</li>
        ) : (
          shown.map((item, i) => {
            const slash = item.path.lastIndexOf("/");
            const dir = slash >= 0 ? item.path.slice(0, slash + 1) : "";
            const base = slash >= 0 ? item.path.slice(slash + 1) : item.path;
            const pos = new Set(item.positions);
            return (
              <li key={item.path}>
                <button
                  type="button"
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => onPick(item.path)}
                  className={`block w-full truncate rounded px-2 py-1 text-left font-mono text-xs ${
                    i === active ? "bg-accent-muted" : "hover:bg-surface-overlay"
                  }`}
                >
                  {dir && <FuzzyText text={dir} positions={pos} offset={0} className="text-tertiary" />}
                  <FuzzyText text={base} positions={pos} offset={dir.length} className="text-primary" />
                </button>
              </li>
            );
          })
        )}
      </ul>
      <p className="mt-2 border-t border-subtle pt-2 text-2xs text-tertiary">{t("files.finderHint")}</p>
    </Modal>
  );
}

/** Renders `text` with fuzzy-matched character positions (offset-adjusted) emphasized. */
function FuzzyText({
  text,
  positions,
  offset,
  className,
}: {
  text: string;
  positions: Set<number>;
  offset: number;
  className?: string;
}) {
  return (
    <span className={className}>
      {[...text].map((ch, i) =>
        positions.has(i + offset) ? (
          <span key={i} className="font-semibold text-accent">
            {ch}
          </span>
        ) : (
          ch
        ),
      )}
    </span>
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
function FilePane({ path, reveal, wsPath }: { path: string; reveal: Reveal | null; wsPath: string }) {
  const t = useT();
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<"rel" | "abs" | null>(null);
  // wrap / view-source are sticky preferences across files (localStorage).
  const [viewSource, setViewSource] = useState(() => localStorage.getItem("sf.files.viewSource") === "1");
  const [wrap, setWrap] = useState(() => localStorage.getItem("sf.files.wrap") === "1");
  const editorRef = useRef<CodeEditorHandle>(null);

  useEffect(() => localStorage.setItem("sf.files.wrap", wrap ? "1" : "0"), [wrap]);
  // Persist the *preference* only on an explicit user toggle (below), not when a
  // reveal auto-switches to source — so a search hit doesn't change the default.
  const toggleViewSource = () =>
    setViewSource((v) => {
      const next = !v;
      localStorage.setItem("sf.files.viewSource", next ? "1" : "0");
      return next;
    });

  // Opening a markdown file at a specific line (search hit) shows source so the
  // line is reachable; this does not persist the preference.
  useEffect(() => {
    if (reveal?.line !== undefined && MARKDOWN_RE.test(path)) setViewSource(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce]);

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
          <Button size="sm" variant="ghost" onClick={toggleViewSource}>
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
          <Button size="sm" variant="ghost" onClick={() => editorRef.current?.goToLine()} title={t("files.gotoLineTitle")}>
            {t("files.gotoLine")}
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
          <Suspense fallback={<p className="px-4 py-4 text-xs text-tertiary">{t("files.loading")}</p>}>
            <CodeEditor ref={editorRef} path={path} value={draft} onChange={setDraft} wrap={wrap} />
          </Suspense>
        ) : showRenderedMarkdown ? (
          <div className="px-4 py-3 text-sm leading-relaxed text-secondary">
            <Markdown source={file.content} />
          </div>
        ) : (
          <Suspense fallback={<p className="px-4 py-4 text-xs text-tertiary">{t("files.loading")}</p>}>
            <CodeEditor
              ref={editorRef}
              path={path}
              value={file.content}
              onChange={() => {}}
              readOnly
              wrap={wrap}
              reveal={reveal ?? undefined}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
