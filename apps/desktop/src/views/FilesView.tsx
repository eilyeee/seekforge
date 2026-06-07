import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { Markdown } from "../components/Markdown";
import { highlightLines, isKnownLang, langFromPath, type TokenClass } from "../lib/highlight";
import { useT } from "../lib/i18n";
import { Badge, Button, EmptyState, IconChevron, IconFiles } from "../components/ui";
import type { FileContent, TreeEntry } from "../types";

/** Highlighter token class → semantic-token color (mirrors Markdown). */
const TOKEN_CLASS: Record<TokenClass, string> = {
  comment: "text-tertiary italic",
  string: "text-ok",
  number: "text-warn",
  keyword: "text-accent",
  literal: "text-warn",
};

/** Read-only file content with dependency-free syntax highlighting by extension. */
function CodeView({ path, content }: { path: string; content: string }) {
  const lang = langFromPath(path);
  const lines = useMemo(() => highlightLines(content, lang), [content, lang]);
  if (!isKnownLang(lang)) {
    return <pre className="px-4 py-3 font-mono text-xs leading-relaxed text-primary">{content}</pre>;
  }
  return (
    <pre className="px-4 py-3 font-mono text-xs leading-relaxed text-primary">
      <code>
        {lines.map((tokens, i) => (
          <div key={i}>
            {tokens.length === 0
              ? "\n"
              : tokens.map((tk, j) => (
                  <span key={j} className={tk.cls ? TOKEN_CLASS[tk.cls] : undefined}>
                    {tk.text}
                  </span>
                ))}
          </div>
        ))}
      </code>
    </pre>
  );
}

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

  // Per-directory listing cache keyed by relative path ("" = root).
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);

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
    loadDir("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

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
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-subtle py-2">
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
                  onSelect={setSelected}
                />
              ))}
            </ul>
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
            <FilePane key={selected} path={selected} />
          )}
        </section>
      </div>
    </div>
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
function FilePane({ path }: { path: string }) {
  const t = useT();
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

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

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-subtle px-4 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-secondary">{path}</span>
        {file?.truncated && <Badge tone="warn">{t("files.truncated")}</Badge>}
        {saved && !editing && <span className="text-2xs text-ok">{t("files.saved")}</span>}
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
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="h-full w-full resize-none bg-transparent px-4 py-3 font-mono text-xs leading-relaxed text-primary focus:outline-none"
          />
        ) : isMarkdown ? (
          <div className="px-4 py-3 text-sm leading-relaxed text-secondary">
            <Markdown source={file.content} />
          </div>
        ) : (
          <CodeView path={path} content={file.content} />
        )}
      </div>
    </div>
  );
}
