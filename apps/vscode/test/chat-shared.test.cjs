const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const shared = require("../media/chat-shared.js");

const { LIMITS, decodeHostMessage, decodeWebviewMessage, parseInline, parseMarkdown, safeUrl } = shared;

const ok = (message) => assert.equal(decodeWebviewMessage(message).ok, true, JSON.stringify(message));
const bad = (message) => assert.equal(decodeWebviewMessage(message).ok, false, JSON.stringify(message));

test("the same file loads as a browser global without a module system", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "media", "chat-shared.js"), "utf8");
  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  assert.equal(typeof sandbox.SeekForgeChat.parseMarkdown, "function");
  assert.equal(Object.isFrozen(sandbox.SeekForgeChat), true);
});

test("webview messages: known shapes pass", () => {
  ok({ type: "ready" });
  ok({ type: "send", text: "fix it", mode: "plan", approvalMode: "acceptEdits", includeContext: false });
  ok({ type: "setOptions", mode: "ask", approvalMode: "auto", includeContext: true });
  ok({ type: "resumeSession", sessionId: "2026-09-17T10-00-00-abc" });
  ok({ type: "permission", requestId: "p1", decision: "once" });
  ok({ type: "permission", requestId: "p1", decision: "hunks", selectedHunks: [0, 2] });
  ok({ type: "permission", requestId: "p1", decision: "deny", feedback: "use pnpm" });
  ok({ type: "question", id: "q1", answer: "" });
  ok({ type: "searchFiles", query: "" });
  ok({ type: "openFile", path: "src/app.ts" });
});

test("webview messages: anything outside the protocol is rejected, not coerced", () => {
  for (const message of [
    null,
    [],
    "send",
    { type: "constructor" },
    { type: "toString" },
    { type: "eval", code: "x" },
    { type: "ready", extra: true },
    { type: "send", text: "   ", mode: "edit", approvalMode: "confirm", includeContext: true },
    {
      type: "send",
      text: "x".repeat(LIMITS.promptChars + 1),
      mode: "edit",
      approvalMode: "confirm",
      includeContext: true,
    },
    { type: "send", text: "hi", mode: "yolo", approvalMode: "confirm", includeContext: true },
    { type: "send", text: "hi", mode: "edit", approvalMode: "bypassPermissions", includeContext: true },
    { type: "send", text: "hi", mode: "edit", approvalMode: "confirm", includeContext: "yes" },
    { type: "send", text: "hi", mode: "edit", approvalMode: "confirm", includeContext: true, sessionId: "x" },
    { type: "resumeSession", sessionId: "../../etc" },
    { type: "permission", requestId: "p1", decision: "everything" },
    { type: "permission", requestId: "p 1", decision: "once" },
    // Hunks only with a hunks decision, and only as distinct non-negative integers.
    { type: "permission", requestId: "p1", decision: "once", selectedHunks: [0] },
    { type: "permission", requestId: "p1", decision: "hunks" },
    { type: "permission", requestId: "p1", decision: "hunks", selectedHunks: [] },
    { type: "permission", requestId: "p1", decision: "hunks", selectedHunks: [1, 1] },
    { type: "permission", requestId: "p1", decision: "hunks", selectedHunks: [-1] },
    { type: "permission", requestId: "p1", decision: "hunks", selectedHunks: [0.5] },
    // Feedback only rides on a denial.
    { type: "permission", requestId: "p1", decision: "once", feedback: "sure" },
    { type: "permission", requestId: "p1", decision: "deny", feedback: "x".repeat(LIMITS.feedbackChars + 1) },
    { type: "question", id: "q1", answer: 3 },
    { type: "openFile", path: "" },
    { type: "openFile", path: "a\0b" },
    { type: "searchFiles", query: "x".repeat(LIMITS.queryChars + 1) },
  ]) {
    bad(message);
  }
});

const usage = { costUsd: 0.1, promptTokens: 10, completionTokens: 2, cacheHitTokens: 1 };
const status = {
  running: false,
  sessionId: null,
  usage: null,
  contextPercent: null,
  planReady: false,
  workspace: null,
  activity: null,
};
const options = { mode: "edit", approvalMode: "confirm", includeContext: true };

test("host messages: the webview accepts well-formed state and drops the rest", () => {
  const good = [
    { type: "reset", items: [], status, permission: null, question: null, options },
    { type: "upsert", item: { id: 1, kind: "assistant", text: "hi", streaming: true } },
    {
      type: "upsert",
      item: { id: 2, kind: "tool", name: "run_command", title: "t", status: "ok", summary: "", detail: "", output: "" },
    },
    {
      type: "upsert",
      item: { id: 3, kind: "report", summary: "done", changedFiles: ["a"], verification: "", usage },
    },
    { type: "append", id: 1, text: " more" },
    { type: "status", status: { ...status, running: true, usage, contextPercent: 12.5 } },
    { type: "sessions", sessions: [{ id: "s", title: "t", updatedAt: "", status: "completed" }] },
    { type: "files", query: "ap", files: ["src/app.ts"] },
    { type: "insertText", text: "@src/app.ts#L1-2 " },
    { type: "notice", level: "warn", message: "careful" },
    { type: "question", pending: { id: "q1", question: "?", options: ["a"], freeText: true, expiresAt: 5 } },
    { type: "focus" },
  ];
  for (const message of good) assert.equal(decodeHostMessage(message).ok, true, JSON.stringify(message));

  const rejected = [
    { type: "upsert", item: { id: 1, kind: "html", text: "<b>" } },
    { type: "upsert", item: { id: -1, kind: "assistant", text: "", streaming: false } },
    {
      type: "upsert",
      item: { id: 1, kind: "tool", name: "x", title: "t", status: "exploded", summary: "", detail: "", output: "" },
    },
    { type: "status", status: { ...status, running: "no" } },
    { type: "status", status: { ...status, usage: { costUsd: Number.NaN } } },
    { type: "permission", pending: { requestId: "p1" } },
    { type: "notice", level: "fatal", message: "x" },
    { type: "insertText", text: "" },
    { type: "reset", items: [], status, permission: null, question: null, options: { ...options, mode: "yolo" } },
    { type: "navigate", url: "https://example.com" },
  ];
  for (const message of rejected) assert.equal(decodeHostMessage(message).ok, false, JSON.stringify(message));
});

test("host messages: a permission card must be complete", () => {
  const view = {
    requestId: "p1",
    toolName: "run_command",
    permission: "execute",
    description: "Run a command",
    command: "npm test",
    allowSession: true,
    allowAlways: false,
    hasDiff: false,
    escalation: false,
    added: 0,
    removed: 0,
    hunks: [],
    expiresAt: 1,
  };
  assert.equal(decodeHostMessage({ type: "permission", pending: view }).ok, true);
  assert.equal(decodeHostMessage({ type: "permission", pending: { ...view, command: 42 } }).ok, false);
  assert.equal(
    decodeHostMessage({ type: "permission", pending: { ...view, hunks: [{ index: -1, preview: "" }] } }).ok,
    false,
  );
});

/** Every string in a parsed tree, to prove markup survives only as text. */
function texts(nodes, out = []) {
  for (const node of nodes) {
    if (typeof node.v === "string") out.push(node.v);
    for (const key of ["c", "header"]) if (Array.isArray(node[key])) texts(node[key].flat(), out);
    if (Array.isArray(node.items))
      texts(
        node.items.flatMap((item) => item.c),
        out,
      );
    if (Array.isArray(node.rows)) texts(node.rows.flat(2), out);
  }
  return out;
}

test("raw HTML in model output stays literal text", () => {
  const blocks = parseMarkdown('<img src=x onerror="alert(1)"> <script>alert(2)</script>\n\n# <b>title</b>');
  assert.deepEqual(
    blocks.map((block) => block.t),
    ["p", "h"],
  );
  assert.deepEqual(texts(blocks), ['<img src=x onerror="alert(1)"> <script>alert(2)</script>', "<b>title</b>"]);
});

test("only http and https links become links", () => {
  assert.equal(safeUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  for (const url of [
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,x",
    "command:workbench.action.quit",
    "vscode://x",
    "https://a b",
    'https://x"onclick',
  ])
    assert.equal(safeUrl(url), null, url);
  assert.deepEqual(parseInline("[click](javascript:alert(1))"), [{ t: "text", v: "[click](javascript:alert(1))" }]);
  assert.deepEqual(parseInline("[docs](https://example.com)"), [
    { t: "a", href: "https://example.com", c: [{ t: "text", v: "docs" }] },
  ]);
  assert.deepEqual(parseInline("see https://example.com/x."), [
    { t: "text", v: "see " },
    { t: "a", href: "https://example.com/x", c: [{ t: "text", v: "https://example.com/x" }] },
    { t: "text", v: "." },
  ]);
});

test("inline code, emphasis and snake_case identifiers", () => {
  assert.deepEqual(parseInline("run `pnpm **test**` now"), [
    { t: "text", v: "run " },
    { t: "code", v: "pnpm **test**" },
    { t: "text", v: " now" },
  ]);
  assert.deepEqual(parseInline("``a ` b``"), [{ t: "code", v: "a ` b" }]);
  assert.deepEqual(parseInline("**bold *and italic* too**"), [
    {
      t: "b",
      c: [
        { t: "text", v: "bold " },
        { t: "i", c: [{ t: "text", v: "and italic" }] },
        { t: "text", v: " too" },
      ],
    },
  ]);
  assert.deepEqual(parseInline("call snake_case_name here"), [{ t: "text", v: "call snake_case_name here" }]);
  assert.deepEqual(parseInline("~~gone~~"), [{ t: "s", c: [{ t: "text", v: "gone" }] }]);
  assert.deepEqual(parseInline("unclosed `tick and 2 * 3 * 4"), [{ t: "text", v: "unclosed `tick and 2 * 3 * 4" }]);
});

test("block structure: fences, lists, quotes, tables, rules", () => {
  const blocks = parseMarkdown(
    [
      "Intro line",
      "second line",
      "",
      "```ts title=x",
      "const a = `b`;",
      "```",
      "- one",
      "  continued",
      "- two",
      "3. three",
      "> quoted **bold**",
      "",
      "| a | b |",
      "|---|:-:|",
      "| 1 | `2` |",
      "---",
    ].join("\n"),
  );
  assert.deepEqual(
    blocks.map((block) => block.t),
    ["p", "codeblock", "ul", "ol", "quote", "table", "hr"],
  );
  assert.deepEqual(blocks[0].c, [{ t: "text", v: "Intro line" }, { t: "br" }, { t: "text", v: "second line" }]);
  assert.deepEqual(blocks[1], { t: "codeblock", lang: "ts", v: "const a = `b`;" });
  assert.equal(blocks[2].items.length, 2);
  assert.deepEqual(blocks[2].items[0].c, [{ t: "text", v: "one" }, { t: "br" }, { t: "text", v: "continued" }]);
  assert.equal(blocks[3].start, 3);
  assert.equal(blocks[4].c[0].t, "p");
  assert.equal(blocks[5].header.length, 2);
  assert.deepEqual(blocks[5].rows[0][1], [{ t: "code", v: "2" }]);
});

test("a fence runs to a closing fence at least as long, and an unclosed one to the end", () => {
  const blocks = parseMarkdown("````md\n```\ninner\n```\n````\nafter");
  assert.deepEqual(blocks[0], { t: "codeblock", lang: "md", v: "```\ninner\n```" });
  assert.equal(blocks[1].t, "p");
  assert.deepEqual(parseMarkdown("```\nnever closed\n# not a heading"), [
    { t: "codeblock", lang: "", v: "never closed\n# not a heading" },
  ]);
  // A fence language that is not a plain token is dropped, not used as a class name.
  assert.equal(parseMarkdown('```"><img>\nx\n```')[0].lang, "");
});

test("oversized or deeply nested input stays bounded and keeps every character", () => {
  const huge = "a".repeat(LIMITS.markdownChars + 10);
  const blocks = parseMarkdown(huge);
  assert.equal(texts(blocks).join("").length, huge.length);
  const nested = `${">".repeat(50)} deep`;
  assert.ok(JSON.stringify(parseMarkdown(nested)).length < 2_000);
  const many = Array.from({ length: LIMITS.markdownBlocks + 50 }, (_, i) => `# h${i}`).join("\n");
  const parsed = parseMarkdown(many);
  assert.ok(parsed.length <= LIMITS.markdownBlocks + 1);
  assert.match(texts(parsed.slice(-1)).join(""), /# h5049$/);
});
