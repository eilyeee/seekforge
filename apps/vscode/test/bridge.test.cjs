const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  SeekForgeBridge,
  normalizeServerUrl,
  permissionDetail,
  readStoredToken,
  taskWithEditorContext,
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

test("permission prompts surface raw commands, paths, and diffs", () => {
  const detail = permissionDetail({
    description: "run a command",
    command: "npm test",
    path: "/repo/package.json",
    preview: { diff: "+changed" },
  });
  assert.match(detail, /Raw command:\nnpm test/);
  assert.match(detail, /Raw path:\n\/repo\/package.json/);
  assert.match(detail, /Proposed diff:\n\+changed/);
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
