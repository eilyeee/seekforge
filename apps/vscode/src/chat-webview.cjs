const crypto = require("node:crypto");

const CHAT_VIEW_ID = "seekforge.chat";
const CHAT_PANEL_TYPE = "seekforge.chatPanel";

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * The content security policy of the chat: nothing loads unless it comes from
 * the extension's own media folder, scripts additionally need this page's
 * nonce, and the page can neither frame, submit forms, nor connect anywhere.
 */
function chatCsp(cspSource, nonce) {
  return [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `style-src ${cspSource}`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

function chatHtml({ cspSource, nonce, styleUri, sharedScriptUri, scriptUri, inEditor }) {
  const attr = escapeAttribute;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${attr(chatCsp(cspSource, nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${attr(styleUri)}">
<title>SeekForge Chat</title>
</head>
<body class="${inEditor ? "in-editor" : "in-sidebar"}">
<header>
  <span id="workspace">New conversation</span>
  <button type="button" id="show-sessions" class="icon-button" title="Resume a stored session" aria-label="Resume a stored session">⟲</button>
  <button type="button" id="new-session" class="icon-button" title="New conversation" aria-label="New conversation">+</button>
  <button type="button" id="open-editor" class="icon-button" title="Open a chat in an editor tab" aria-label="Open a chat in an editor tab">⧉</button>
</header>
<section id="sessions" hidden>
  <div class="sessions-head"><span>Stored sessions</span><button type="button" id="close-sessions" class="icon-button" aria-label="Close the session list">✕</button></div>
  <div id="sessions-list"></div>
</section>
<main id="transcript">
  <div id="empty">
    <p class="empty-line">Ask about this workspace, or ask SeekForge to change it.</p>
    <p class="empty-line">Type @ to mention a file. Enter sends, Shift+Enter adds a line.</p>
  </div>
</main>
<div id="plan-bar" hidden><button type="button" id="execute-plan" class="primary">Execute plan</button></div>
<div id="permission" hidden></div>
<div id="question" hidden></div>
<div id="activity" role="status" aria-live="polite" hidden></div>
<div id="composer-box">
  <div id="mentions" role="listbox" aria-label="Files" hidden></div>
  <textarea id="composer" rows="3" placeholder="Message SeekForge — @ to mention a file" aria-label="Message SeekForge" aria-autocomplete="list" aria-controls="mentions" aria-expanded="false"></textarea>
  <div class="controls">
    <select id="mode" aria-label="Mode" title="Ask: read-only answers · Edit: make changes · Plan: a read-only plan to review first"></select>
    <select id="approval" aria-label="Approval mode" title="Confirm each: ask before every write or command · Accept edits: apply file edits, ask for commands · Auto: approve writes and commands (dangerous calls are still refused)"></select>
    <label class="toggle" title="Attach the selection, open files, and the active file's errors"><input type="checkbox" id="include-context" checked> Context</label>
    <button type="button" id="add-selection" class="icon-button" title="Attach the current selection">+ Selection</button>
    <span class="spacer"></span>
    <button type="button" id="stop" class="danger" hidden>Stop</button>
    <button type="button" id="send" class="primary">Send</button>
  </div>
</div>
<footer id="footer">No usage yet</footer>
<script nonce="${attr(nonce)}" src="${attr(sharedScriptUri)}"></script>
<script nonce="${attr(nonce)}" src="${attr(scriptUri)}"></script>
</body>
</html>`;
}

/**
 * The sidebar chat plus any number of editor-tab chats. Each surface owns one
 * ChatController (one conversation); the host keeps the state, so a webview
 * that is re-created simply asks for a fresh snapshot.
 */
function createChatViews(vscode, extensionUri, { createController, onPanelsChanged = () => {} }) {
  const mediaRoot = vscode.Uri.joinPath(extensionUri, "media");
  const webviewOptions = { enableScripts: true, enableCommandUris: false, localResourceRoots: [mediaRoot] };

  const render = (webview, inEditor) => {
    webview.html = chatHtml({
      cspSource: webview.cspSource,
      nonce: crypto.randomBytes(18).toString("base64url"),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "chat.css")).toString(),
      sharedScriptUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "chat-shared.js")).toString(),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "chat.js")).toString(),
      inEditor,
    });
  };

  const bind = (webview, controller) => {
    const detach = controller.attach((message) => {
      void webview.postMessage(message);
    });
    const receiving = webview.onDidReceiveMessage((message) => controller.handleMessage(message));
    return () => {
      detach();
      receiving.dispose();
    };
  };

  let sidebar;
  const panels = new Set();
  const sidebarController = createController({
    isVisible: () => Boolean(sidebar?.visible),
    reveal: () => reveal(),
    openInEditor: () => openPanel(),
  });
  const sidebarSurface = { controller: sidebarController };
  let lastFocused = sidebarSurface;

  const provider = {
    resolveWebviewView(view) {
      view.webview.options = webviewOptions;
      render(view.webview, false);
      const unbind = bind(view.webview, sidebarController);
      sidebar = view;
      const visibility = view.onDidChangeVisibility(() => {
        if (view.visible) lastFocused = sidebarSurface;
      });
      view.onDidDispose(() => {
        unbind();
        visibility.dispose();
        if (sidebar === view) sidebar = undefined;
      });
    },
  };
  const registration = vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, provider, {
    webviewOptions: { retainContextWhenHidden: true },
  });

  async function reveal() {
    await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
    lastFocused = sidebarSurface;
    void sidebar?.webview.postMessage({ type: "focus" });
  }

  function openPanel() {
    const panel = vscode.window.createWebviewPanel(
      CHAT_PANEL_TYPE,
      "SeekForge Chat",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { ...webviewOptions, retainContextWhenHidden: true },
    );
    panel.iconPath = vscode.Uri.joinPath(mediaRoot, "seekforge.svg");
    render(panel.webview, true);
    const surface = { panel };
    surface.controller = createController({
      isVisible: () => panel.visible,
      reveal: async () => {
        panel.reveal(undefined, false);
        lastFocused = surface;
      },
      openInEditor: () => openPanel(),
    });
    const unbind = bind(panel.webview, surface.controller);
    panels.add(surface);
    lastFocused = surface;
    const viewState = panel.onDidChangeViewState(() => {
      if (panel.active) lastFocused = surface;
    });
    panel.onDidDispose(() => {
      unbind();
      viewState.dispose();
      surface.controller.dispose();
      panels.delete(surface);
      if (lastFocused === surface) lastFocused = sidebarSurface;
      onPanelsChanged(panels.size);
    });
    onPanelsChanged(panels.size);
    return surface;
  }

  /** The chat a command should act on: the one the user used last. */
  function current() {
    return lastFocused && (lastFocused === sidebarSurface || panels.has(lastFocused)) ? lastFocused : sidebarSurface;
  }

  async function focusCurrent() {
    const surface = current();
    if (surface === sidebarSurface) await reveal();
    else {
      surface.panel.reveal(undefined, false);
      void surface.panel.webview.postMessage({ type: "focus" });
    }
    return surface;
  }

  return {
    reveal,
    openPanel,
    current,
    focusCurrent,
    controllers: () => [sidebarController, ...[...panels].map((surface) => surface.controller)],
    dispose() {
      registration.dispose();
      for (const surface of [...panels]) surface.panel.dispose();
      sidebarController.dispose();
    },
  };
}

module.exports = { CHAT_PANEL_TYPE, CHAT_VIEW_ID, chatCsp, chatHtml, createChatViews, escapeAttribute };
