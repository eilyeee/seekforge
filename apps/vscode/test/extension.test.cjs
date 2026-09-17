const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const posix = process.platform !== "win32";
const TOKEN = "dGhpc2lzYXRlc3R0b2tlbmZvcnRoZWV4dGVuc2lvbg";

/** Just enough of the VS Code API for activate() and the commands under test. */
function fakeVscode({ settings = {}, folders = [] } = {}) {
  const commands = new Map();
  const executed = [];
  const messages = [];
  const terminals = [];
  const providers = new Map();
  const listeners = { folders: new Set(), config: new Set() };
  class EventEmitter {
    constructor() {
      this.listeners = new Set();
      this.event = (listener) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
    }
    fire(value) {
      for (const listener of [...this.listeners]) listener(value);
    }
    dispose() {
      this.listeners.clear();
    }
  }
  const disposable = () => ({ dispose() {} });
  const message =
    (level) =>
    async (text, ...items) => {
      messages.push({ level, text, items });
      return undefined;
    };
  const api = {
    EventEmitter,
    ThemeIcon: class {
      constructor(id) {
        this.id = id;
      }
    },
    ThemeColor: class {},
    StatusBarAlignment: { Right: 2 },
    ProgressLocation: { Notification: 15 },
    ViewColumn: { Beside: -2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    Uri: {
      joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join("/") }),
      file: (fsPath) => ({ scheme: "file", fsPath, path: fsPath }),
      from: (parts) => parts,
    },
    env: { appName: "Visual Studio Code - Insiders" },
    window: {
      createOutputChannel: () => ({
        lines: [],
        appendLine(line) {
          this.lines.push(line);
        },
        show() {},
        dispose() {},
      }),
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      registerWebviewViewProvider: (id, provider) => {
        providers.set(id, provider);
        return disposable();
      },
      registerTreeDataProvider: disposable,
      showErrorMessage: message("error"),
      showWarningMessage: message("warning"),
      showInformationMessage: message("info"),
      withProgress: (_options, task) => task(),
      createTerminal: (options) => {
        const terminal = {
          options,
          disposed: false,
          show() {},
          dispose() {
            this.disposed = true;
          },
        };
        terminals.push(terminal);
        return terminal;
      },
      activeTextEditor: undefined,
      tabGroups: { all: [] },
    },
    languages: { getDiagnostics: () => [] },
    workspace: {
      isTrusted: true,
      workspaceFolders: folders.map((folder) => ({ uri: { scheme: "file", fsPath: folder } })),
      getWorkspaceFolder: () => undefined,
      getConfiguration: (section) => ({
        get: (key, fallback) => {
          const full = `${section}.${key}`;
          return Object.hasOwn(settings, full) ? settings[full] : fallback;
        },
        inspect: (key) => ({ globalValue: settings[`${section}.${key}`], defaultValue: "seekforge" }),
        update: async () => {},
      }),
      registerTextDocumentContentProvider: disposable,
      onDidChangeWorkspaceFolders: (listener) => {
        listeners.folders.add(listener);
        return disposable();
      },
      onDidChangeConfiguration: (listener) => {
        listeners.config.add(listener);
        return disposable();
      },
    },
    commands: {
      registerCommand: (id, handler) => {
        commands.set(id, handler);
        return disposable();
      },
      executeCommand: async (...args) => {
        executed.push(args);
      },
    },
  };
  return { api, commands, executed, messages, terminals, providers, listeners, settings };
}

function loadExtension(t, fake) {
  const originalLoad = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === "vscode") return fake.api;
    return originalLoad.call(this, request, ...rest);
  };
  t.after(() => {
    Module._load = originalLoad;
  });
  const file = require.resolve("../src/extension.cjs");
  delete require.cache[file];
  return require(file);
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function useHome(t) {
  const home = tempDir(t, "seekforge-ext-home-");
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return home;
}

function extensionContext() {
  const secrets = new Map();
  return {
    subscriptions: [],
    extensionUri: { path: "/ext" },
    secrets: {
      get: async (key) => secrets.get(key),
      store: async (key, value) => secrets.set(key, value),
      delete: async (key) => secrets.delete(key),
    },
    stored: secrets,
  };
}

async function waitFor(predicate, what) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function getJson(port, token, pathname = "/v1/context") {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: pathname, headers: { authorization: `Bearer ${token}` } }, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      })
      .on("error", reject);
  });
}

test("activation registers the commands and the chat view, and starts the IDE bridge", {
  timeout: 20_000,
}, async (t) => {
  const home = useHome(t);
  const fake = fakeVscode({ folders: ["/work/project"] });
  const extension = loadExtension(t, fake);
  const context = extensionContext();
  extension.activate(context);
  t.after(() => extension.deactivate());

  for (const id of ["seekforge.focusChat", "seekforge.startServer", "seekforge.insertSelection", "seekforge.newTask"]) {
    assert.ok(fake.commands.has(id), id);
  }
  assert.ok(fake.providers.has("seekforge.chat"));

  const dir = path.join(home, ".seekforge", "ide");
  await waitFor(
    () => fs.existsSync(dir) && fs.readdirSync(dir).some((name) => name.endsWith(".json")),
    "the lock file",
  );
  const [name] = fs.readdirSync(dir).filter((entry) => /^\d+\.json$/.test(entry));
  const lock = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  assert.equal(lock.ideName, "Visual Studio Code - Insiders");
  assert.deepEqual(lock.workspaceFolders, ["/work/project"]);
  assert.equal(lock.pid, process.pid);
  const response = await getJson(lock.port, lock.token);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { openFiles: [], diagnostics: [] });

  await fake.commands.get("seekforge.focusChat")();
  assert.deepEqual(fake.executed.at(-1), ["seekforge.chat.focus"]);

  await extension.deactivate();
  assert.equal(fs.existsSync(path.join(dir, name)), false);
});

test("the IDE bridge stays off when disabled, and follows the setting", { timeout: 20_000 }, async (t) => {
  const home = useHome(t);
  const fake = fakeVscode({ settings: { "seekforge.ideBridge.enabled": false } });
  const extension = loadExtension(t, fake);
  extension.activate(extensionContext());
  t.after(() => extension.deactivate());
  const dir = path.join(home, ".seekforge", "ide");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(dir), false);

  fake.settings["seekforge.ideBridge.enabled"] = true;
  for (const listener of fake.listeners.config)
    listener({ affectsConfiguration: (key) => key === "seekforge.ideBridge.enabled" });
  await waitFor(() => fs.existsSync(dir) && fs.readdirSync(dir).length > 0, "the lock file");

  fake.settings["seekforge.ideBridge.enabled"] = false;
  for (const listener of fake.listeners.config)
    listener({ affectsConfiguration: (key) => key === "seekforge.ideBridge.enabled" });
  await waitFor(() => fs.readdirSync(dir).length === 0, "the lock file to go away");
});

test("start server refuses a remote server URL", { timeout: 20_000 }, async (t) => {
  useHome(t);
  const fake = fakeVscode({
    settings: { "seekforge.serverUrl": "https://agent.example", "seekforge.ideBridge.enabled": false },
    folders: ["/work/project"],
  });
  const extension = loadExtension(t, fake);
  extension.activate(extensionContext());
  t.after(() => extension.deactivate());
  await fake.commands.get("seekforge.startServer")();
  assert.match(fake.messages.at(-1).text, /can only start a server on this machine/);
  assert.equal(fake.terminals.length, 0);
});

test("start server runs the user's command, saves the printed token, and masks it", {
  skip: !posix,
  timeout: 20_000,
}, async (t) => {
  useHome(t);
  const bin = tempDir(t, "seekforge-ext-bin-");
  const project = tempDir(t, "seekforge-ext-project-");
  const argsFile = path.join(bin, "args.txt");
  const script = path.join(bin, "seekforge");
  fs.writeFileSync(
    script,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho "SeekForge server: http://127.0.0.1:7373/?token=${TOKEN}"\nexec sleep 30\n`,
    { mode: 0o755 },
  );
  const fake = fakeVscode({
    settings: { "seekforge.serveCommand": script, "seekforge.ideBridge.enabled": false },
    folders: [project],
  });
  const extension = loadExtension(t, fake);
  const context = extensionContext();
  extension.activate(context);
  t.after(() => extension.deactivate());

  await fake.commands.get("seekforge.startServer")();
  assert.equal(context.stored.get("seekforge.token"), TOKEN);
  assert.deepEqual(fs.readFileSync(argsFile, "utf8").trim().split("\n"), ["serve", project, "--port", "7373"]);
  assert.match(fake.messages.at(-1).text, /running on 127\.0\.0\.1:7373/);

  const [terminal] = fake.terminals;
  const written = [];
  terminal.options.pty.onDidWrite((text) => written.push(text));
  terminal.options.pty.open();
  const output = written.join("");
  assert.match(output, /^\$ .*seekforge serve .* --port 7373\r\n/);
  assert.match(output, /token=<saved to VS Code>/);
  assert.doesNotMatch(output, new RegExp(TOKEN));

  // Starting again while it runs just shows the terminal.
  await fake.commands.get("seekforge.startServer")();
  assert.equal(fake.terminals.length, 1);

  await fake.commands.get("seekforge.stopServer")();
  assert.equal(terminal.disposed, true);
});

test("a workspace-level serve command is ignored", { skip: !posix, timeout: 20_000 }, async (t) => {
  useHome(t);
  const fake = fakeVscode({ settings: { "seekforge.ideBridge.enabled": false }, folders: ["/work/project"] });
  // Only the user-level (global) value is honored; inspect() here reports none.
  fake.api.workspace.getConfiguration = () => ({
    get: (_key, fallback) => fallback,
    inspect: () => ({ workspaceValue: "/tmp/evil", defaultValue: "seekforge-does-not-exist-here" }),
    update: async () => {},
  });
  const extension = loadExtension(t, fake);
  extension.activate(extensionContext());
  t.after(() => extension.deactivate());
  await fake.commands.get("seekforge.startServer")();
  assert.match(fake.messages.at(-1).text, /Could not run "seekforge-does-not-exist-here"/);
});
