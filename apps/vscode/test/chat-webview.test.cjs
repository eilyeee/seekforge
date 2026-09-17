const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  CHAT_PANEL_TYPE,
  CHAT_VIEW_ID,
  chatCsp,
  chatHtml,
  createChatViews,
  escapeAttribute,
} = require("../src/chat-webview.cjs");

const root = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

const html = chatHtml({
  cspSource: "https://file+.vscode-resource.vscode-cdn.net",
  nonce: "abc123",
  styleUri: "https://file+.vscode-resource.vscode-cdn.net/media/chat.css",
  sharedScriptUri: "https://file+.vscode-resource.vscode-cdn.net/media/chat-shared.js",
  scriptUri: 'https://file+.vscode-resource.vscode-cdn.net/media/chat.js?"><script>',
  inEditor: false,
});

test("the chat page has a strict nonce CSP and no inline or remote code", () => {
  const csp = chatCsp("CSP-SOURCE", "n0nce");
  assert.match(csp, /^default-src 'none'; /);
  assert.match(csp, /script-src 'nonce-n0nce'(;|$)/);
  assert.match(csp, /style-src CSP-SOURCE(;|$)/);
  for (const directive of ["connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'"]) {
    assert.ok(csp.includes(directive), directive);
  }
  assert.doesNotMatch(csp, /unsafe-(inline|eval)/);

  assert.ok(html.includes("content=\"default-src 'none'; img-src https://file+.vscode-resource.vscode-cdn.net data:;"));
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 2);
  for (const [, attributes, body] of scripts) {
    assert.match(attributes, /nonce="abc123"/);
    assert.equal(body.trim(), "", "no inline script bodies");
  }
  // Attribute values are escaped: a hostile URI cannot open a new tag.
  assert.ok(html.includes('chat.js?&quot;&gt;&lt;script&gt;"'));
  assert.doesNotMatch(html, /\sstyle=/);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.equal(escapeAttribute(`<"&'>`), `&lt;&quot;&amp;'&gt;`);
});

test("every element the webview script looks up exists in the page", () => {
  const script = read("media", "chat.js");
  const ids = new Set([...script.matchAll(/byId\("([^"]+)"\)/g)].map((match) => match[1]));
  assert.ok(ids.size > 15);
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
});

test("webview scripts never turn strings into markup or code", () => {
  for (const file of ["chat.js", "chat-shared.js"]) {
    const source = read("media", file)
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    for (const pattern of [
      /\.innerHTML\b/,
      /\.outerHTML\b/,
      /insertAdjacentHTML/,
      /document\.write/,
      /\beval\(/,
      /new Function\(/,
      /setAttribute\(\s*["'](on|style|href|src)/i,
      /\.srcdoc\b/,
      /createContextualFragment/,
      /DOMParser/,
    ]) {
      assert.doesNotMatch(source, pattern, `${file} uses ${pattern}`);
    }
  }
});

function fakeVscode() {
  const registered = [];
  const panels = [];
  const executed = [];
  const emitter = () => {
    const listeners = new Set();
    const event = (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    };
    const fire = (value) => {
      for (const listener of [...listeners]) listener(value);
    };
    return { event, fire, listeners };
  };
  const webview = () => {
    const received = emitter();
    return {
      cspSource: "vscode-resource:",
      options: undefined,
      html: "",
      posted: [],
      postMessage(message) {
        this.posted.push(message);
        return Promise.resolve(true);
      },
      asWebviewUri: (uri) => ({ toString: () => `vscode-resource:${uri.path}` }),
      onDidReceiveMessage: received.event,
      receive: received.fire,
      received,
    };
  };
  const api = {
    Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join("/") }) },
    ViewColumn: { Beside: -2 },
    window: {
      registerWebviewViewProvider: (id, provider, options) => {
        registered.push({ id, provider, options });
        return { dispose: () => registered.push({ disposed: id }) };
      },
      createWebviewPanel: (type, title, show, options) => {
        const disposed = emitter();
        const viewState = emitter();
        const panel = {
          type,
          title,
          show,
          options,
          visible: true,
          active: true,
          webview: webview(),
          reveals: 0,
          reveal() {
            this.reveals += 1;
          },
          onDidDispose: disposed.event,
          onDidChangeViewState: viewState.event,
          dispose() {
            disposed.fire();
          },
          viewState,
        };
        panels.push(panel);
        return panel;
      },
    },
    commands: { executeCommand: async (...args) => executed.push(args) },
  };
  return { api, registered, panels, executed, webview, emitter };
}

function fakeController(created) {
  return (hooks) => {
    const controller = {
      hooks,
      messages: [],
      posts: [],
      disposed: false,
      attach(post) {
        this.posts.push(post);
        return () => this.posts.splice(this.posts.indexOf(post), 1);
      },
      handleMessage(message) {
        this.messages.push(message);
      },
      dispose() {
        this.disposed = true;
      },
    };
    created.push(controller);
    return controller;
  };
}

test("the sidebar view is locked down and routes messages to its conversation", async () => {
  const fake = fakeVscode();
  const created = [];
  const views = createChatViews(fake.api, { path: "/ext" }, { createController: fakeController(created) });
  const [registration] = fake.registered;
  assert.equal(registration.id, CHAT_VIEW_ID);
  assert.equal(registration.options.webviewOptions.retainContextWhenHidden, true);

  const webview = fake.webview();
  const visibility = fake.emitter();
  const disposed = fake.emitter();
  const view = { webview, visible: true, onDidChangeVisibility: visibility.event, onDidDispose: disposed.event };
  registration.provider.resolveWebviewView(view);
  assert.deepEqual(webview.options, {
    enableScripts: true,
    enableCommandUris: false,
    localResourceRoots: [{ path: "/ext/media" }],
  });
  assert.match(webview.html, /vscode-resource:\/ext\/media\/chat\.js/);
  assert.match(webview.html, /class="in-sidebar"/);

  const [sidebar] = created;
  webview.receive({ type: "ready" });
  assert.deepEqual(sidebar.messages, [{ type: "ready" }]);
  sidebar.posts[0]({ type: "focus" });
  assert.deepEqual(webview.posted, [{ type: "focus" }]);
  assert.equal(sidebar.hooks.isVisible(), true);

  await views.focusCurrent();
  assert.deepEqual(fake.executed, [[`${CHAT_VIEW_ID}.focus`]]);

  disposed.fire();
  assert.equal(sidebar.posts.length, 0);
  assert.equal(webview.received.listeners.size, 0);
  assert.equal(sidebar.hooks.isVisible(), false);
});

test("editor-tab chats are separate conversations with their own lifecycle", async () => {
  const fake = fakeVscode();
  const created = [];
  const counts = [];
  const views = createChatViews(
    fake.api,
    { path: "/ext" },
    {
      createController: fakeController(created),
      onPanelsChanged: (count) => counts.push(count),
    },
  );
  const surface = views.openPanel();
  const [panel] = fake.panels;
  assert.equal(panel.type, CHAT_PANEL_TYPE);
  assert.equal(panel.options.enableCommandUris, false);
  assert.equal(panel.options.retainContextWhenHidden, true);
  assert.match(panel.webview.html, /class="in-editor"/);
  assert.equal(created.length, 2);
  assert.equal(views.current(), surface);
  assert.deepEqual(views.controllers(), created);

  panel.webview.receive({ type: "stop" });
  assert.deepEqual(created[1].messages, [{ type: "stop" }]);
  await views.focusCurrent();
  assert.equal(panel.reveals, 1);
  assert.deepEqual(panel.webview.posted, [{ type: "focus" }]);

  // The sidebar's "open in editor" hook opens another tab.
  created[0].hooks.openInEditor();
  assert.equal(fake.panels.length, 2);

  panel.dispose();
  assert.equal(created[1].disposed, true);
  assert.equal(views.controllers().length, 2);
  assert.deepEqual(counts, [1, 2, 1]);
  views.dispose();
  assert.equal(created[2].disposed, true);
  assert.equal(created[0].disposed, true);
  assert.ok(fake.registered.some((entry) => entry.disposed === CHAT_VIEW_ID));
});

test("the shipped code needs nothing outside Node, VS Code, and this package", () => {
  // The release VSIX is packaged with `vsce --no-dependencies`, so node_modules never ships.
  const manifest = JSON.parse(read("package.json"));
  assert.equal(manifest.dependencies, undefined);
  for (const file of fs.readdirSync(path.join(root, "src"))) {
    const source = read("src", file);
    for (const [, target] of source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
      assert.ok(
        target === "vscode" || target.startsWith("node:") || target.startsWith("./") || target.startsWith("../media/"),
        `${file} requires ${target}`,
      );
    }
  }
});

test("the manifest declares every command the extension registers, and nothing else", () => {
  const manifest = JSON.parse(read("package.json"));
  const extension = read("src", "extension.cjs");
  const registered = new Set([...extension.matchAll(/registerCommand\("([^"]+)"/g)].map((match) => match[1]));
  const declared = new Set(manifest.contributes.commands.map((command) => command.command));
  assert.deepEqual([...registered].sort(), [...declared].sort());
  for (const menu of Object.values(manifest.contributes.menus).flat()) {
    assert.ok(declared.has(menu.command), menu.command);
  }
  for (const binding of manifest.contributes.keybindings) assert.ok(declared.has(binding.command), binding.command);
});

test("the manifest wires the chat view, keybindings, and settings the code reads", () => {
  const manifest = JSON.parse(read("package.json"));
  const { contributes } = manifest;
  assert.deepEqual(manifest.activationEvents, ["onStartupFinished"]);
  assert.equal(contributes.views.seekforge[0].id, CHAT_VIEW_ID);
  assert.equal(contributes.views.seekforge[0].type, "webview");
  const container = contributes.viewsContainers.activitybar[0];
  assert.equal(container.id, "seekforge");
  assert.ok(fs.existsSync(path.join(root, container.icon)));
  for (const file of ["chat.js", "chat-shared.js", "chat.css"])
    assert.ok(fs.existsSync(path.join(root, "media", file)));

  const bindings = Object.fromEntries(contributes.keybindings.map((binding) => [binding.command, binding]));
  assert.equal(bindings["seekforge.focusChat"].mac, "cmd+escape");
  assert.equal(bindings["seekforge.focusChat"].key, "ctrl+escape");
  assert.equal(bindings["seekforge.insertSelection"].mac, "cmd+alt+k");
  assert.equal(bindings["seekforge.insertSelection"].key, "ctrl+alt+k");
  assert.equal(bindings["seekforge.insertSelection"].when, "editorTextFocus");

  const properties = contributes.configuration.properties;
  const extension = read("src", "extension.cjs");
  const readKeys = [
    ...[...extension.matchAll(/getConfiguration\("seekforge"\)\.(?:get|inspect)\("([^"]+)"/g)].map(
      (m) => `seekforge.${m[1]}`,
    ),
    ...[...extension.matchAll(/config\.get\("([^"]+)"/g)].map((m) =>
      m[1].startsWith("include") ? `seekforge.context.${m[1]}` : `seekforge.${m[1]}`,
    ),
  ];
  assert.ok(readKeys.length >= 6);
  for (const key of readKeys) assert.ok(properties[key], `${key} is read but not declared`);
  assert.equal(properties["seekforge.ideBridge.enabled"].default, true);
  assert.equal(properties["seekforge.ideBridge.enabled"].scope, "machine");
});
