import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { gotoLine, openSearchPanel, search } from "@codemirror/search";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { rust } from "@codemirror/lang-rust";
import { java } from "@codemirror/lang-java";
import { go } from "@codemirror/lang-go";
import { cpp } from "@codemirror/lang-cpp";
import { php } from "@codemirror/lang-php";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { sql } from "@codemirror/lang-sql";

/** Maps a file extension to a CodeMirror language extension (highlight + completion). */
function languageFor(path: string): Extension[] {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? "").toLowerCase();
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return [javascript()];
    case "jsx":
      return [javascript({ jsx: true })];
    case "ts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "json":
      return [json()];
    case "py":
      return [python()];
    case "md":
    case "markdown":
      return [markdown()];
    case "html":
    case "htm":
      return [html()];
    case "css":
    case "scss":
    case "less":
      return [css()];
    case "rs":
      return [rust()];
    case "java":
      return [java()];
    case "go":
      return [go()];
    case "c":
    case "h":
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
    case "hh":
      return [cpp()];
    case "php":
      return [php()];
    case "xml":
    case "svg":
      return [xml()];
    case "yaml":
    case "yml":
      return [yaml()];
    case "sql":
      return [sql()];
    default:
      return [];
  }
}

function isDark(): boolean {
  return typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark";
}

/**
 * Always-on completion source: suggests identifiers already present in the file.
 * This guarantees per-file suggestions even for languages whose CM package has no
 * dedicated completion source; language sources (JS/TS/Python/HTML/CSS/SQL/…)
 * still augment it where available.
 */
function documentWords(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/[\w$]+/);
  if (!before || (before.from === before.to && !context.explicit)) return null;
  const typed = before.text;
  const seen = new Set<string>([typed]);
  const options: { label: string; type: string }[] = [];
  const re = /[A-Za-z_$][\w$]{1,}/g;
  const text = context.state.doc.toString();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && options.length < 250) {
    const w = m[0];
    if (seen.has(w)) continue;
    seen.add(w);
    options.push({ label: w, type: "text" });
  }
  if (options.length === 0) return null;
  return { from: before.from, options, validFor: /^[\w$]*$/ };
}

/** Imperative handle: lets the toolbar open the find/replace + go-to-line panels. */
export type CodeEditorHandle = { openSearch: () => void; goToLine: () => void };

/**
 * CodeMirror 6 editor for the Files view: in-editor syntax highlighting,
 * language-aware autocompletion (basicSetup), find/replace (Ctrl/Cmd+F, or the
 * exposed openSearch()), tab-indent, and a light/dark theme synced to the app's
 * data-theme. `readOnly` renders the same editor for viewing (search/select/copy
 * without editing). Mounts per file (keyed by path).
 */
export const CodeEditor = forwardRef<
  CodeEditorHandle,
  {
    path: string;
    value: string;
    onChange: (v: string) => void;
    readOnly?: boolean;
    /** Soft-wrap long lines. */
    wrap?: boolean;
    /**
     * Reveal a location on open / when `nonce` changes: 1-based `line`, optional
     * 0-based `col` + `len` to select the match. `nonce` forces a re-reveal even
     * when the location is unchanged (e.g. clicking the same search hit again).
     */
    reveal?: { line: number; col?: number; len?: number; nonce: number };
  }
>(function CodeEditor({ path, value, onChange, readOnly = false, wrap = false, reveal }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeComp = useRef(new Compartment());
  const wrapComp = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useImperativeHandle(ref, () => ({
    // openSearchPanel focuses the search field itself — don't call view.focus()
    // after, or focus snaps back to the editor and away from the query input.
    openSearch: () => {
      const view = viewRef.current;
      if (view) openSearchPanel(view);
    },
    goToLine: () => {
      const view = viewRef.current;
      if (view) gotoLine(view);
    },
  }));

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          // Explicit search state so the find panel (and openSearch) work in
          // read-only views too; it renders at the top, VS Code-style.
          search({ top: true }),
          keymap.of([indentWithTab, { key: "Mod-g", run: gotoLine, preventDefault: true }]),
          wrapComp.current.of(wrap ? EditorView.lineWrapping : []),
          ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
          ...languageFor(path),
          // Document-word suggestions for every file type (augments language ones).
          EditorState.languageData.of(() => [{ autocomplete: documentWords }]),
          themeComp.current.of(isDark() ? oneDark : []),
          EditorView.theme({
            "&": { height: "100%" },
            ".cm-scroller": { fontFamily: "inherit" },
            // Theme the find/replace panel to the app tokens (light + dark).
            ".cm-panels": { backgroundColor: "var(--sf-surface-raised)", color: "var(--sf-text-primary)" },
            ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--sf-border-subtle)" },
            ".cm-search input": {
              backgroundColor: "var(--sf-surface)",
              color: "var(--sf-text-primary)",
              border: "1px solid var(--sf-border-subtle)",
              borderRadius: "4px",
              padding: "2px 6px",
            },
            ".cm-search .cm-button": {
              backgroundImage: "none",
              backgroundColor: "var(--sf-surface-overlay)",
              color: "var(--sf-text-secondary)",
              border: "1px solid var(--sf-border-subtle)",
              borderRadius: "4px",
            },
            ".cm-search label": { fontSize: "12px", color: "var(--sf-text-secondary)" },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => view.destroy();
    // Recreate when the file changes (new language + initial doc) or mode flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, readOnly]);

  // Sync external value changes (e.g. cancel/reset) without clobbering typing.
  useEffect(() => {
    const view = viewRef.current;
    if (view && value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  // Toggle soft-wrap without recreating the editor.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: wrapComp.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  // Reveal a line (and select the match span) — e.g. a project-search hit.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !reveal) return;
    const lineNo = Math.max(1, Math.min(reveal.line, view.state.doc.lines));
    const line = view.state.doc.line(lineNo);
    const from = Math.min(line.from + (reveal.col ?? 0), line.to);
    const to = Math.min(from + (reveal.len ?? 0), line.to);
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    // Re-run on mount and on nonce change (same hit re-clicked). Deliberately
    // excludes `value` so editing/saving a file doesn't re-jump to a stale hit.
  }, [reveal?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the app's light/dark switch at runtime.
  useEffect(() => {
    const obs = new MutationObserver(() => {
      viewRef.current?.dispatch({ effects: themeComp.current.reconfigure(isDark() ? oneDark : []) });
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  return <div ref={host} className="h-full overflow-hidden" />;
});
