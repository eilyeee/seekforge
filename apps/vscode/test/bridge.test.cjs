const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  SeekForgeBridge,
  formatAgentEvent,
  hasDiffPreview,
  normalizeServerUrl,
  permissionHunkItems,
  permissionSummary,
  readStoredToken,
  taskWithEditorContext,
  usageSummary,
  websocketUrl,
  withWorkspace,
  writeStoredToken,
  workspaceRootForEditor,
} = require("../src/bridge.cjs");

test("builds an authenticated websocket URL without preserving unrelated query state", () => {
  assert.equal(websocketUrl("https://agent.example/base/", "a b"), "wss://agent.example/base/ws?token=a%20b");
  assert.equal(websocketUrl("http://127.0.0.1:3847", ""), "ws://127.0.0.1:3847/ws");
});

test("rejects non-HTTP server URLs and normalizes trailing state", () => {
  assert.equal(normalizeServerUrl("https://agent.example/base///?old=1#hash"), "https://agent.example/base");
  assert.throws(() => normalizeServerUrl("file:///tmp/socket"), /http or https/);
  assert.throws(() => normalizeServerUrl("https://user:secret@agent.example/base"), /must not include credentials/);
});

test("adds a workspace id safely", () => {
  assert.equal(withWorkspace("/api/diff", "ws / one"), "/api/diff?ws=ws%20%2F%20one");
});

test("selects the active editor's workspace in a multi-root window", () => {
  const first = { uri: { fsPath: "/repo/first" } };
  const second = { uri: { fsPath: "/repo/second" } };
  const activeUri = { fsPath: "/repo/second/src/app.ts" };
  const workspaceApi = {
    workspaceFolders: [first, second],
    getWorkspaceFolder: (uri) => (uri === activeUri ? second : undefined),
  };

  assert.equal(workspaceRootForEditor(workspaceApi, { document: { uri: activeUri } }), "/repo/second");
  assert.equal(workspaceRootForEditor(workspaceApi, undefined), "/repo/first");
});

test("fails closed when the server does not host the selected workspace", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ workspaces: [{ id: "first", path: "/repo/first" }] }), { status: 200 });
  const bridge = new SeekForgeBridge({ serverUrl: "http://localhost", token: "", WebSocketImpl: class {}, fetchImpl });

  await assert.rejects(bridge.workspaceId("/repo/second"), /does not host the VS Code workspace/);
  assert.equal(await bridge.workspaceId("/repo/first/"), "first");
});

test("includes only active files inside the workspace", () => {
  const editor = {
    document: { uri: { fsPath: "/repo/src/app.ts" }, getText: () => "const selected = true;" },
    selection: {},
  };
  assert.match(taskWithEditorContext("review", editor, "/repo"), /@src\/app\.ts/);
  assert.equal(taskWithEditorContext("review", editor, "/other"), "review");
});

test("permission prompts surface raw commands and paths, and route diffs to a document", () => {
  const request = {
    description: "run a command",
    command: "npm test",
    path: "/repo/package.json",
    preview: { diff: "+changed" },
  };
  const detail = permissionSummary(request);
  assert.match(detail, /Raw command:\nnpm test/);
  assert.match(detail, /Raw path:\n\/repo\/package.json/);
  // The diff is opened as a document, so it must not be inlined into the modal.
  assert.doesNotMatch(detail, /\+changed/);
  assert.equal(hasDiffPreview(request), true);
  assert.equal(hasDiffPreview({ description: "read a file" }), false);
  assert.equal(hasDiffPreview({ description: "empty", preview: { diff: "" } }), false);
});

test("offers per-hunk selection only for genuinely multi-hunk edits", () => {
  assert.deepEqual(permissionHunkItems({ hunks: [{ index: 0, preview: "only" }] }), []);
  assert.deepEqual(permissionHunkItems({}), []);
  const items = permissionHunkItems({
    hunks: [
      { index: 0, preview: "-  a\n+  b" },
      { index: 1, preview: "-  c\n+  d" },
    ],
  });
  assert.deepEqual(
    items.map((item) => [item.label, item.index, item.picked]),
    [
      ["Hunk 1", 0, true],
      ["Hunk 2", 1, true],
    ],
  );
  assert.equal(items[0].detail, "- a + b");
});

test("renders tool activity, subagents, and failures as single output rows", () => {
  assert.equal(
    formatAgentEvent({ type: "tool.started", toolName: "run_command", args: { command: "npm test" } }),
    "⏺ run_command(npm test)",
  );
  assert.equal(
    formatAgentEvent({ type: "tool.completed", toolName: "run_command", result: { ok: true, data: "2 passed" } }),
    "  ⎿ 2 passed",
  );
  assert.equal(
    formatAgentEvent({
      type: "tool.completed",
      toolName: "apply_patch",
      result: { ok: false, error: { code: "e", message: "no match" } },
    }),
    "  ⎿ error: no match",
  );
  assert.equal(formatAgentEvent({ type: "file.changed", path: "src/app.ts" }), "  ± src/app.ts");
  assert.equal(
    formatAgentEvent({
      type: "subagent.completed",
      agentId: "explorer",
      dispatchId: "d",
      task: "t",
      status: "done",
      resultSummary: "found it",
    }),
    "  ⎿ subagent explorer done: found it",
  );
  assert.equal(formatAgentEvent({ type: "model.delta", chunk: "x" }), null);
  assert.equal(formatAgentEvent(undefined), null);
});

test("clips long tool arguments without severing surrogate pairs", () => {
  const line = formatAgentEvent({ type: "tool.started", toolName: "search_text", args: { pattern: "🙂".repeat(200) } });
  // 160 code points plus the ellipsis, never a lone surrogate half.
  assert.equal(Array.from(line).filter((character) => character === "🙂").length, 160);
  assert.match(line, /…\)$/);
});

test("reports cost first and marks cache hits in the usage readout", () => {
  assert.equal(
    usageSummary({ promptTokens: 12_500, completionTokens: 800, cacheHitTokens: 3_100, costUsd: 0.004242 }),
    "$0.0042 · 12.5k prompt (3.1k cached) · 800 completion",
  );
  assert.equal(
    usageSummary({ promptTokens: 10, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 }),
    "$0.0000 · 10 prompt · 0 completion",
  );
  assert.equal(usageSummary(undefined), "");
});

test("migrates legacy tokens to SecretStorage and supports clearing", async () => {
  const values = new Map();
  const storage = {
    get: async (key) => values.get(key),
    store: async (key, value) => values.set(key, value),
    delete: async (key) => values.delete(key),
  };

  assert.equal(await readStoredToken(storage, "legacy-token"), "legacy-token");
  assert.equal(values.get("seekforge.token"), "legacy-token");
  await writeStoredToken(storage, "new-token");
  assert.equal(await readStoredToken(storage, "ignored"), "new-token");
  await writeStoredToken(storage, "");
  assert.equal(await readStoredToken(storage), "");
});

test("bounds REST calls with an aborting timeout", async () => {
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  const bridge = new SeekForgeBridge({
    serverUrl: "http://localhost",
    token: "",
    WebSocketImpl: class {},
    fetchImpl,
    requestTimeoutMs: 5,
  });

  await assert.rejects(bridge.request("/api/health"), (error) => error.name === "AbortError");
});

test("cancelling an active run sends cancel before closing the socket", async () => {
  class FakeSocket extends EventEmitter {
    static instance;
    sent = [];

    constructor() {
      super();
      FakeSocket.instance = this;
      queueMicrotask(() => this.emit("open"));
    }

    send(payload) {
      this.sent.push(JSON.parse(payload));
    }

    close() {
      this.emit("close");
    }
  }

  const controller = new AbortController();
  const bridge = new SeekForgeBridge({
    serverUrl: "http://localhost",
    token: "",
    WebSocketImpl: FakeSocket,
    runTimeoutMs: 1_000,
  });
  const running = bridge.run({ type: "start", task: "x" }, async () => {}, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(running, (error) => error.name === "AbortError");
  assert.deepEqual(FakeSocket.instance.sent, [{ type: "start", task: "x" }, { type: "cancel" }]);
});
