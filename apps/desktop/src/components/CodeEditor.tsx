import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
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

/**
 * CodeMirror 6 editor for the Files view: in-editor syntax highlighting,
 * language-aware autocompletion (basicSetup), tab-indent, and light/dark theme
 * synced to the app's data-theme. Mounts per edit session (keyed by file path).
 */
export function CodeEditor({
  path,
  value,
  onChange,
}: {
  path: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeComp = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          ...languageFor(path),
          // Document-word suggestions for every file type (augments language ones).
          EditorState.languageData.of(() => [{ autocomplete: documentWords }]),
          themeComp.current.of(isDark() ? oneDark : []),
          EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { fontFamily: "inherit" } }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => view.destroy();
    // Recreate when the file changes (new language + initial doc).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Sync external value changes (e.g. cancel/reset) without clobbering typing.
  useEffect(() => {
    const view = viewRef.current;
    if (view && value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  // Follow the app's light/dark switch at runtime.
  useEffect(() => {
    const obs = new MutationObserver(() => {
      viewRef.current?.dispatch({ effects: themeComp.current.reconfigure(isDark() ? oneDark : []) });
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  return <div ref={host} className="h-full overflow-hidden" />;
}
