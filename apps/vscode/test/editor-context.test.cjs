const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  MAX_BRIDGE_DIAGNOSTICS,
  MAX_OPEN_FILES,
  activeSelection,
  bridgeContext,
  clipText,
  contextLabels,
  diagnosticRows,
  gatherPromptContext,
  openFilePaths,
  relativeInside,
  selectionRange,
  selectionReference,
  taskWithContext,
} = require("../src/editor-context.cjs");

const ROOT = path.resolve("/repo");
const file = (relative) => ({ scheme: "file", fsPath: path.join(ROOT, relative) });
const position = (line, character) => ({ line, character });
const selection = (startLine, startChar, endLine, endChar) => ({
  start: position(startLine, startChar),
  end: position(endLine, endChar),
  isEmpty: startLine === endLine && startChar === endChar,
});

function editor(relative, text, sel, languageId = "typescript") {
  return {
    document: { uri: file(relative), languageId, getText: (range) => (range === sel ? text : "WHOLE FILE") },
    selection: sel,
  };
}

function diagnostic(severity, line, character, message, source) {
  return { severity, message, source, range: { start: position(line, character), end: position(line, character + 1) } };
}

function fakeVscode({ active, tabs = [], diagnostics = [] }) {
  return {
    window: {
      activeTextEditor: active,
      tabGroups: { all: [{ tabs: tabs.map((input) => ({ input })) }] },
    },
    languages: {
      getDiagnostics: (uri) => {
        if (!uri) return diagnostics;
        return diagnostics.find(([candidate]) => candidate.fsPath === uri.fsPath)?.[1] ?? [];
      },
    },
  };
}

test("selection ranges are 1-based and a trailing column-0 line is not included", () => {
  assert.equal(selectionRange(selection(3, 2, 3, 2)), undefined);
  assert.deepEqual(selectionRange(selection(3, 2, 3, 9)), { startLine: 4, endLine: 4 });
  assert.deepEqual(selectionRange(selection(3, 0, 6, 0)), { startLine: 4, endLine: 6 });
  assert.deepEqual(selectionRange(selection(3, 0, 6, 1)), { startLine: 4, endLine: 7 });
});

test("the active selection is bounded without splitting a surrogate pair", () => {
  const sel = selection(0, 0, 0, 5);
  const text = `${"a".repeat(9)}😀tail`;
  const picked = activeSelection(editor("src/app.ts", text, sel), 10);
  assert.equal(picked.text, "a".repeat(9));
  assert.equal(picked.truncated, true);
  assert.equal(clipText("😀😀", 3), "😀");
  assert.equal(activeSelection(editor("src/app.ts", "", sel)), undefined);
  const untitled = {
    document: { uri: { scheme: "untitled", fsPath: "Untitled-1" }, getText: () => "x" },
    selection: sel,
  };
  assert.equal(activeSelection(untitled), undefined);
  assert.equal(activeSelection(undefined), undefined);
});

test("open files are file-scheme, deduplicated, and bounded", () => {
  const tabs = [
    { uri: file("a.ts") },
    { uri: file("a.ts") },
    { uri: { scheme: "untitled", fsPath: "Untitled-1" } },
    { original: file("b.ts"), modified: file("b.ts") },
    { uri: { scheme: "seekforge-review", fsPath: "/r1/original/x" } },
    {},
    undefined,
  ];
  const windowApi = { tabGroups: { all: [{ tabs: tabs.map((input) => ({ input })) }, { tabs: [] }] } };
  assert.deepEqual(openFilePaths(windowApi), [path.join(ROOT, "a.ts"), path.join(ROOT, "b.ts")]);
  const many = {
    tabGroups: { all: [{ tabs: Array.from({ length: 80 }, (_, i) => ({ input: { uri: file(`f${i}.ts`) } })) }] },
  };
  assert.equal(openFilePaths(many).length, MAX_OPEN_FILES);
  assert.deepEqual(openFilePaths(undefined), []);
});

test("diagnostics are 1-based, errors first, and bounded per severity", () => {
  const rows = diagnosticRows([
    [file("a.ts"), [diagnostic(2, 0, 0, "info"), diagnostic(0, 4, 2, "boom", "ts"), diagnostic(1, 1, 1, "careful")]],
    [{ scheme: "untitled", fsPath: "x" }, [diagnostic(0, 0, 0, "ignored")]],
    [file("b.ts"), [diagnostic(3, 9, 0, "hint"), diagnostic(7, 0, 0, "unknown severity")]],
    "not an entry",
  ]);
  assert.deepEqual(
    rows.map((row) => [row.severity, row.message]),
    [
      ["error", "boom"],
      ["warning", "careful"],
      ["info", "info"],
      ["info", "unknown severity"],
      ["hint", "hint"],
    ],
  );
  assert.deepEqual(rows[0], {
    path: path.join(ROOT, "a.ts"),
    line: 5,
    column: 3,
    severity: "error",
    message: "boom",
    source: "ts",
  });
  assert.equal("source" in rows[1], false);

  const flood = Array.from({ length: 5_000 }, (_, i) => diagnostic(3, i, 0, `hint ${i}`));
  const errors = Array.from({ length: 3 }, (_, i) => diagnostic(0, i, 0, `error ${i}`));
  const bounded = diagnosticRows([[file("big.ts"), [...flood, ...errors]]]);
  assert.equal(bounded.length, MAX_BRIDGE_DIAGNOSTICS);
  assert.deepEqual(
    bounded.slice(0, 3).map((row) => row.message),
    ["error 0", "error 1", "error 2"],
  );
});

test("the bridge context has exactly the contract's fields", () => {
  const sel = selection(1, 0, 2, 4);
  const vscode = fakeVscode({
    active: editor("src/app.ts", "line two\nline", sel),
    tabs: [{ uri: file("src/app.ts") }, { uri: file("README.md") }],
    diagnostics: [[file("src/app.ts"), [diagnostic(0, 0, 0, "bad")]]],
  });
  assert.deepEqual(bridgeContext(vscode), {
    activeFile: path.join(ROOT, "src/app.ts"),
    selection: { path: path.join(ROOT, "src/app.ts"), startLine: 2, endLine: 3, text: "line two\nline" },
    openFiles: [path.join(ROOT, "src/app.ts"), path.join(ROOT, "README.md")],
    diagnostics: [{ path: path.join(ROOT, "src/app.ts"), line: 1, column: 1, severity: "error", message: "bad" }],
  });
  assert.deepEqual(bridgeContext(fakeVscode({ active: undefined })), { openFiles: [], diagnostics: [] });
});

test("workspace containment is decided on path segments, not string prefixes", () => {
  assert.equal(relativeInside(ROOT, path.join(ROOT, "src", "a.ts")), "src/a.ts");
  assert.equal(relativeInside(ROOT, path.join(ROOT, "..foo")), "..foo");
  assert.equal(relativeInside(ROOT, `${ROOT}2${path.sep}a.ts`), undefined);
  assert.equal(relativeInside(ROOT, path.resolve(ROOT, "..", "other.ts")), undefined);
  assert.equal(relativeInside(ROOT, ROOT), undefined);
  assert.equal(relativeInside(undefined, "x"), undefined);
});

test("a selection reference names the file and its lines", () => {
  const one = { path: path.join(ROOT, "src/a.ts"), startLine: 3, endLine: 3 };
  assert.equal(selectionReference(ROOT, one), "@src/a.ts#L3");
  assert.equal(selectionReference(ROOT, { ...one, endLine: 9 }), "@src/a.ts#L3-9");
  assert.equal(selectionReference(ROOT, { ...one, path: "/elsewhere/a.ts" }), undefined);
});

test("prompt context honors the toggles and never cites files outside the workspace", () => {
  const sel = selection(0, 0, 0, 3);
  const vscode = fakeVscode({
    active: editor("src/app.ts", "abc", sel),
    tabs: [{ uri: file("src/app.ts") }, { uri: { scheme: "file", fsPath: "/elsewhere/secret.ts" } }],
    diagnostics: [
      [
        file("src/app.ts"),
        [diagnostic(0, 1, 1, "Cannot find name 'x'.\nsecond line", "ts"), diagnostic(1, 0, 0, "warn")],
      ],
    ],
  });
  const all = gatherPromptContext(vscode, ROOT, { selection: true, openFiles: true, diagnostics: true });
  assert.equal(all.activeFile, "src/app.ts");
  assert.equal(all.selection.text, "abc");
  assert.deepEqual(all.openFiles, ["src/app.ts"]);
  assert.deepEqual(all.errors, [{ line: 2, column: 2, message: "Cannot find name 'x'.\nsecond line", source: "ts" }]);

  const none = gatherPromptContext(vscode, ROOT, { selection: false, openFiles: false, diagnostics: false });
  assert.deepEqual(none, { workspaceRoot: ROOT, activeFile: "src/app.ts" });

  const outside = gatherPromptContext(vscode, path.resolve("/other"), {
    selection: true,
    openFiles: true,
    diagnostics: true,
  });
  assert.equal(outside.activeFile, undefined);
  assert.equal(outside.selection, undefined);
  assert.equal(outside.errors, undefined);
});

test("the context section fences code so a selection cannot close its block", () => {
  const context = {
    workspaceRoot: ROOT,
    activeFile: "src/app.ts",
    selection: {
      path: path.join(ROOT, "src/app.ts"),
      startLine: 1,
      endLine: 2,
      text: "```\n# injected heading\n```",
      truncated: false,
      languageId: "typescript",
    },
    openFiles: ["src/app.ts", "b.ts"],
    errors: [{ line: 3, column: 1, message: "bad\nthing", source: "ts" }],
  };
  const pinned = [
    {
      path: path.join(ROOT, "lib/x.py"),
      startLine: 5,
      endLine: 5,
      text: "x = 1",
      truncated: true,
      languageId: "py thon",
    },
  ];
  const task = taskWithContext("  explain this  ", context, pinned);
  assert.ok(task.startsWith("explain this\n\n---\nEditor context from VS Code"));
  assert.match(task, /Selected @src\/app\.ts lines 1-2:\n````typescript\n```\n# injected heading\n```\n````/);
  // An unsafe language id is dropped from the fence rather than interpolated.
  assert.match(task, /Attached @lib\/x\.py lines 5-5 \(first 5 characters\):\n```\nx = 1\n```/);
  assert.match(task, /Open files: @src\/app\.ts, @b\.ts/);
  assert.match(task, /Errors reported in @src\/app\.ts:\n- 3:1 bad thing \[ts\]/);
  assert.equal(taskWithContext("plain", { workspaceRoot: ROOT }), "plain");
  assert.equal(taskWithContext("plain", undefined), "plain");

  assert.deepEqual(contextLabels(context, pinned), [
    "selection src/app.ts:1-2",
    "@lib/x.py#L5",
    "2 open file(s)",
    "1 error(s)",
  ]);
  assert.deepEqual(contextLabels({ workspaceRoot: ROOT, activeFile: "a.ts" }), ["active a.ts"]);
  assert.deepEqual(contextLabels(undefined), []);
});
