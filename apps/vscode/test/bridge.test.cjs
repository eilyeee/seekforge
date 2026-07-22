const assert = require("node:assert/strict");
const test = require("node:test");
const {
  SeekForgeBridge,
  permissionDetail,
  taskWithEditorContext,
  websocketUrl,
  withWorkspace,
  workspaceRootForEditor,
} = require("../src/bridge.cjs");

test("builds an authenticated websocket URL without preserving unrelated query state", () => {
  assert.equal(websocketUrl("https://agent.example/base/", "a b"), "wss://agent.example/base/ws?token=a%20b");
  assert.equal(websocketUrl("http://127.0.0.1:3847", ""), "ws://127.0.0.1:3847/ws");
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
