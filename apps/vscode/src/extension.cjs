const path = require("node:path");
const vscode = require("vscode");
const {
  DEFAULT_SERVER_URL,
  SeekForgeBridge,
  connectionProblem,
  formatLoopReport,
  formatTranscript,
  hasDiffPreview,
  isLoopbackHttpUrl,
  loopRow,
  readStoredToken,
  serverUrlPort,
  usageSummary,
  withWorkspace,
  workspaceRootForEditor,
  writeStoredToken,
} = require("./bridge.cjs");
const { ChatController } = require("./chat-controller.cjs");
const { createChatViews } = require("./chat-webview.cjs");
const {
  activeSelection,
  bridgeContext,
  gatherPromptContext,
  relativeInside,
  selectionReference,
} = require("./editor-context.cjs");
const { startIdeBridge } = require("./ide-bridge.cjs");
const { createReviewDocuments } = require("./review-documents.cjs");
const { ServeProcess, serveInvocation } = require("./serve-launcher.cjs");
const { WebSocketClient } = require("./websocket-client.cjs");

function serverUrlSetting() {
  return vscode.workspace.getConfiguration("seekforge").get("serverUrl", DEFAULT_SERVER_URL) || DEFAULT_SERVER_URL;
}

async function configuredBridge(context) {
  const config = vscode.workspace.getConfiguration("seekforge");
  const legacyToken = config.get("token", "");
  const token = await readStoredToken(context.secrets, legacyToken);
  if (legacyToken) {
    for (const target of [
      vscode.ConfigurationTarget.Global,
      vscode.ConfigurationTarget.Workspace,
      vscode.ConfigurationTarget.WorkspaceFolder,
    ]) {
      await config.update("token", undefined, target).catch(() => {});
    }
  }
  return new SeekForgeBridge({ serverUrl: serverUrlSetting(), token, WebSocketImpl: WebSocketClient });
}

/**
 * A persistent cost/token readout: DeepSeek cache-hit accounting is a product
 * guarantee, so a run's spend stays visible after the chat is hidden.
 */
function createStatusBar() {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = "seekforge.focusChat";
  const render = (running, usage) => {
    const summary = usage ? usageSummary(usage) : "";
    item.text = running ? "$(sync~spin) SeekForge" : summary ? "$(check) SeekForge" : "$(rocket) SeekForge";
    if (summary) item.text += ` ${summary.split(" · ")[0]}`;
    item.tooltip = summary ? `SeekForge — ${summary}` : "SeekForge: open the chat";
    item.show();
  };
  render(false, undefined);
  return { render, dispose: () => item.dispose() };
}

async function runSafely(action) {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      void vscode.window.showInformationMessage(error.message);
    } else {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }
}

/**
 * The three-step preamble every workspace-scoped command shares: a configured
 * bridge, a workspace folder, and the server's id for it. Returns an empty
 * bridge (after telling the user why) rather than throwing, because "no folder
 * open" is a state, not a failure.
 */
async function connected(context, what) {
  const bridge = await configuredBridge(context);
  const workspaceRoot = workspaceRootForEditor(vscode.workspace, vscode.window.activeTextEditor);
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(`Open a workspace folder before ${what}.`);
    return {};
  }
  return { bridge, workspaceRoot, workspaceId: await bridge.workspaceId(workspaceRoot) };
}

/** One icon per reader-facing Loop outcome; the server still owns the status itself. */
const LOOP_ICONS = {
  active: new vscode.ThemeIcon("sync"),
  pass: new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed")),
  fail: new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed")),
  cancelled: new vscode.ThemeIcon("circle-slash"),
  pending: new vscode.ThemeIcon("question"),
};

/**
 * A read-only view of the server's persisted Loops. It keeps no cached list and
 * runs no background timer: `getChildren` fetches on demand, so two refreshes
 * cannot race a stale response into the tree and an idle editor window never
 * polls a server the user may not be running. Every failure — no folder open,
 * no server, a folder this server does not host — renders as a row instead of
 * throwing, because a rejected `getChildren` leaves the view blank with no
 * explanation.
 */
function createLoopsView(context) {
  const changed = new vscode.EventEmitter();
  const provider = {
    onDidChangeTreeData: changed.event,
    async getChildren(element) {
      if (element) return [];
      const workspaceRoot = workspaceRootForEditor(vscode.workspace, vscode.window.activeTextEditor);
      if (!workspaceRoot) return [{ kind: "note", message: "Open a workspace folder to list SeekForge loops." }];
      try {
        const bridge = await configuredBridge(context);
        const workspaceId = await bridge.workspaceId(workspaceRoot);
        const loops = await bridge.loops(workspaceId);
        if (loops.length === 0) return [{ kind: "note", message: "No loops recorded for this workspace yet." }];
        return loops.map((loop) => ({ kind: "loop", loop, workspaceId }));
      } catch (error) {
        return [{ kind: "note", message: error instanceof Error ? error.message : String(error) }];
      }
    },
    getTreeItem(element) {
      if (element.kind === "note") {
        const note = new vscode.TreeItem(element.message, vscode.TreeItemCollapsibleState.None);
        note.tooltip = element.message;
        return note;
      }
      const row = loopRow(element.loop);
      const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
      // Two loops can share a task string; the loop id keeps selection stable.
      if (row.loopId) item.id = row.loopId;
      item.description = row.description;
      item.tooltip = `${row.description}\n${row.detail}`;
      item.iconPath = LOOP_ICONS[row.outcome];
      // The workspace travels with the row: the active editor may have moved to
      // another folder between the fetch and the click.
      item.command = {
        command: "seekforge.showLoop",
        title: "Open loop",
        arguments: [{ loopId: row.loopId, workspaceId: element.workspaceId }],
      };
      return item;
    },
  };
  return { provider, refresh: () => changed.fire(undefined), dispose: () => changed.dispose() };
}

async function pickLoopId(bridge, workspaceId) {
  const loops = await bridge.loops(workspaceId);
  if (loops.length === 0) {
    void vscode.window.showInformationMessage("No SeekForge loops recorded for this workspace yet.");
    return "";
  }
  const picked = await vscode.window.showQuickPick(
    loops.map((loop) => loopRow(loop)),
    { placeHolder: "Open a SeekForge loop" },
  );
  return picked?.loopId ?? "";
}

/**
 * Renders one persisted Loop as a Markdown document. The tree passes the loop
 * and the workspace it was listed under; from the palette the user picks one.
 */
async function openLoopReport(context, target) {
  let loopId = typeof target?.loopId === "string" ? target.loopId : "";
  let workspaceId = typeof target?.workspaceId === "string" ? target.workspaceId : "";
  let bridge;
  if (loopId && workspaceId) {
    bridge = await configuredBridge(context);
  } else {
    const session = await connected(context, "opening a SeekForge loop");
    if (!session.bridge) return;
    bridge = session.bridge;
    workspaceId = session.workspaceId;
    loopId = await pickLoopId(bridge, workspaceId);
    if (!loopId) return;
  }
  const loop = await bridge.loop(workspaceId, loopId);
  // History is retained separately and rotates out; losing it must not cost the
  // reader the state they actually asked for.
  // A history that could not be read must not render as a loop that has none.
  const history = await bridge
    .loopHistoryTail(workspaceId, loopId)
    .catch((error) => ({ entries: [], dropped: 0, truncated: false, error }));
  const document = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: formatLoopReport(loop, history.entries, history),
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

/** Shell-style quoting, for showing (never running) the command line. */
function displayArgument(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * `seekforge serve` started by the extension, in a terminal the user can see
 * and close. The printed token is saved to SecretStorage and masked in the
 * terminal; closing the terminal stops the server.
 */
function createServerLauncher(context) {
  let current;

  async function start() {
    if (current && !current.child.exited) {
      current.terminal.show(true);
      return;
    }
    const serverUrl = serverUrlSetting();
    if (!isLoopbackHttpUrl(serverUrl)) {
      throw new Error(
        `seekforge.serverUrl is ${serverUrl}. VS Code can only start a server on this machine; set it to ${DEFAULT_SERVER_URL}.`,
      );
    }
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before starting a SeekForge server for it.");
    const folders = (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === "file")
      .map((folder) => folder.uri.fsPath);
    if (folders.length === 0) throw new Error("Open a folder before starting a SeekForge server.");
    // Only a user-level value counts: a repository must not choose what VS Code runs.
    const inspected = vscode.workspace.getConfiguration("seekforge").inspect("serveCommand");
    const command = String(inspected?.globalValue || inspected?.defaultValue || "seekforge");
    const invocation = serveInvocation({ command, folders, port: serverUrlPort(serverUrl) });
    const shown = [command, "serve", ...folders.filter((f) => !invocation.skipped.includes(f))];
    const display = [...shown, "--port", String(serverUrlPort(serverUrl))].map(displayArgument).join(" ");

    const child = new ServeProcess({
      command: invocation.command,
      args: invocation.args,
      shell: invocation.shell,
      cwd: folders[0],
    });
    const write = new vscode.EventEmitter();
    const closed = new vscode.EventEmitter();
    const backlog = [];
    let opened = false;
    const toTerminal = (text) => text.replace(/\r?\n/g, "\r\n");
    const stopOutput = child.onOutput((text) => {
      if (opened) write.fire(toTerminal(text));
      else backlog.push(text);
    });
    const stopExit = child.onExit((code, signal) => {
      write.fire(`\r\n[seekforge serve exited: ${code ?? signal}]\r\n`);
      if (current?.child === child) current = undefined;
    });
    const terminal = vscode.window.createTerminal({
      name: "SeekForge Server",
      iconPath: new vscode.ThemeIcon("server-process"),
      isTransient: true,
      pty: {
        onDidWrite: write.event,
        onDidClose: closed.event,
        open: () => {
          opened = true;
          write.fire(`$ ${display}\r\n`);
          for (const text of backlog.splice(0)) write.fire(toTerminal(text));
        },
        close: () => {
          void child.stop();
        },
        handleInput: (data) => {
          if (data === "\x03") void child.stop().then(() => closed.fire());
        },
      },
    });
    const entry = {
      child,
      terminal,
      dispose: async () => {
        await child.stop();
        stopOutput();
        stopExit();
        write.dispose();
        closed.dispose();
      },
    };
    current = entry;
    terminal.show(true);

    let ready;
    try {
      ready = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Starting seekforge serve…" },
        () => child.ready,
      );
    } catch (error) {
      // A server that never reported its address must not keep running
      // unmanaged; its terminal stays open so the output can be read.
      await child.stop();
      if (current === entry) current = undefined;
      if (error?.code === "ENOENT") {
        throw new Error(
          `Could not run "${command}". Install the CLI with "npm install -g seekforge", or set seekforge.serveCommand.`,
        );
      }
      throw error;
    }
    await writeStoredToken(context.secrets, ready.token);
    if (invocation.skipped.length > 0) {
      void vscode.window.showWarningMessage(
        `These folders were not passed to seekforge serve because their paths cannot be quoted safely for cmd.exe: ${invocation.skipped.join(", ")}`,
      );
    }
    void vscode.window.showInformationMessage(
      `SeekForge server is running on 127.0.0.1:${ready.port}; its token is saved in VS Code.`,
    );
  }

  async function stop() {
    const entry = current;
    current = undefined;
    if (!entry) return;
    await entry.dispose();
    entry.terminal.dispose();
  }

  return { start, stop, dispose: stop };
}

/** The active selection as a pinned attachment for the chat, or undefined outside the workspace. */
function pinCurrentSelection(root) {
  const selection = activeSelection(vscode.window.activeTextEditor);
  const workspaceRoot = root ?? workspaceRootForEditor(vscode.workspace, vscode.window.activeTextEditor);
  const reference = selection ? selectionReference(workspaceRoot, selection) : undefined;
  return reference ? { reference, selection } : undefined;
}

function contextToggles() {
  const config = vscode.workspace.getConfiguration("seekforge.context");
  return {
    selection: config.get("includeSelection", true),
    openFiles: config.get("includeOpenFiles", true),
    diagnostics: config.get("includeDiagnostics", true),
  };
}

function manageIdeBridge(context, reviews, output) {
  let bridge;
  let starting;
  const enabled = () => vscode.workspace.getConfiguration("seekforge").get("ideBridge.enabled", true);
  const folders = () =>
    (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === "file")
      .map((folder) => folder.uri.fsPath);

  async function openFile({ path: target, line }) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    const options = { preview: false };
    if (line !== undefined) {
      const position = new vscode.Position(Math.min(line, document.lineCount) - 1, 0);
      options.selection = new vscode.Range(position, position);
    }
    await vscode.window.showTextDocument(document, options);
  }

  async function start() {
    if (bridge || starting || !enabled()) return;
    starting = startIdeBridge({
      ideName: vscode.env.appName,
      workspaceFolders: folders,
      handlers: {
        context: () => bridgeContext(vscode),
        openDiff: (input) => reviews.openDiff(input),
        openFile,
      },
    })
      .then((started) => {
        bridge = started;
        output.appendLine(`[ide] bridge listening on 127.0.0.1:${started.port} (${started.lockPath})`);
      })
      .catch((error) => {
        output.appendLine(`[ide] bridge not started: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        starting = undefined;
      });
    await starting;
  }

  async function stop() {
    await starting;
    const running = bridge;
    bridge = undefined;
    await running?.close();
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => bridge?.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("seekforge.ideBridge.enabled")) return;
      void (enabled() ? start() : stop());
    }),
  );
  void start();
  return { stop };
}

let deactivateTasks = [];

function activate(context) {
  const output = vscode.window.createOutputChannel("SeekForge");
  const statusBar = createStatusBar();
  const loopsView = createLoopsView(context);
  const reviews = createReviewDocuments(vscode);
  const server = createServerLauncher(context);
  const ideBridge = manageIdeBridge(context, reviews, output);
  const activeSessions = new Set();
  let offering = false;

  async function offerHelp(error) {
    if (offering) return;
    const problem = connectionProblem(error);
    const url = serverUrlSetting();
    offering = true;
    try {
      if (problem === "offline") {
        const choice = await vscode.window.showWarningMessage(
          `No SeekForge server is answering at ${url}.`,
          ...(isLoopbackHttpUrl(url) ? ["Start Server"] : []),
          "Set Token",
          "Open Settings",
        );
        if (choice === "Start Server") await runSafely(() => server.start());
        else if (choice === "Set Token") await vscode.commands.executeCommand("seekforge.setToken");
        else if (choice === "Open Settings") {
          await vscode.commands.executeCommand("workbench.action.openSettings", "seekforge.serverUrl");
        }
      } else if (problem === "unauthorized") {
        const choice = await vscode.window.showWarningMessage(
          `The SeekForge server at ${url} rejected the saved token.`,
          "Set Token",
          ...(isLoopbackHttpUrl(url) ? ["Restart Server from VS Code"] : []),
        );
        if (choice === "Set Token") await vscode.commands.executeCommand("seekforge.setToken");
        else if (choice) {
          await server.stop();
          await runSafely(() => server.start());
        }
      }
    } finally {
      offering = false;
    }
  }

  let views;
  const refreshStatusBar = () => {
    const controllers = views ? views.controllers() : [];
    const running = controllers.some((controller) => controller.running);
    const usage = views?.current().controller.state.status.usage ?? undefined;
    statusBar.render(running, usage);
  };

  function createController({ isVisible, reveal, openInEditor }) {
    return new ChatController({
      connect: async (root) => {
        const bridge = await configuredBridge(context);
        const workspaceRoot = root ?? workspaceRootForEditor(vscode.workspace, vscode.window.activeTextEditor);
        if (!workspaceRoot) throw new Error("Open a workspace folder before chatting with SeekForge.");
        return { bridge, workspaceRoot, workspaceId: await bridge.workspaceId(workspaceRoot) };
      },
      gatherContext: (workspaceRoot) => gatherPromptContext(vscode, workspaceRoot, contextToggles()),
      pinSelection: pinCurrentSelection,
      reviewDiff: async (request) => {
        if (!hasDiffPreview(request)) return;
        const title = `SeekForge: ${request.toolName} ${request.preview.path ?? ""}`.trim();
        const opened = await reviews.openPreview(request.preview.diff, title);
        if (opened) return;
        const document = await vscode.workspace.openTextDocument({ language: "diff", content: request.preview.diff });
        await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
      },
      openWorkspaceFile: async (root, relative) => {
        const target = path.resolve(root, relative);
        if (!relativeInside(root, target)) return;
        await vscode.window.showTextDocument(vscode.Uri.file(target), { preview: true });
      },
      openInEditor: async () => {
        openInEditor();
      },
      attention: (kind, text) => {
        if (isVisible()) return;
        const message = kind === "permission" ? `SeekForge needs your approval: ${text}` : `SeekForge asks: ${text}`;
        void vscode.window.showWarningMessage(message, "Show").then((choice) => {
          if (choice) void reveal();
        });
      },
      onProblem: (error) => {
        void offerHelp(error);
      },
      onStatus: () => refreshStatusBar(),
      log: (line) => output.appendLine(line),
      activeSessions,
    });
  }

  views = createChatViews(vscode, context.extensionUri, {
    createController,
    onPanelsChanged: () => refreshStatusBar(),
  });

  deactivateTasks = [() => server.stop(), () => ideBridge.stop()];

  context.subscriptions.push(
    output,
    statusBar,
    loopsView,
    reviews,
    views,
    vscode.window.registerTreeDataProvider("seekforge.loops", loopsView.provider),
    vscode.commands.registerCommand("seekforge.refreshLoops", () => loopsView.refresh()),
    vscode.commands.registerCommand("seekforge.showLoop", (target) => runSafely(() => openLoopReport(context, target))),
    vscode.commands.registerCommand("seekforge.showOutput", () => output.show(true)),
    vscode.commands.registerCommand("seekforge.focusChat", () => runSafely(() => views.focusCurrent())),
    vscode.commands.registerCommand("seekforge.openChatInEditor", () => runSafely(async () => views.openPanel())),
    vscode.commands.registerCommand("seekforge.newTask", () =>
      runSafely(async () => {
        const surface = await views.focusCurrent();
        surface.controller.newSession();
      }),
    ),
    vscode.commands.registerCommand("seekforge.resumeSession", () =>
      runSafely(async () => {
        const surface = await views.focusCurrent();
        await surface.controller.handleMessage({ type: "listSessions" });
      }),
    ),
    vscode.commands.registerCommand("seekforge.insertSelection", () =>
      runSafely(async () => {
        const surface = views.current();
        // Read the selection before focus moves: an editor-area chat tab
        // becomes the active editor and hides the text editor's selection.
        const pinned = pinCurrentSelection(surface.controller.workspace?.root);
        await views.focusCurrent();
        surface.controller.addSelection(pinned);
      }),
    ),
    vscode.commands.registerCommand("seekforge.stopRun", () => views.current().controller.stop()),
    vscode.commands.registerCommand("seekforge.startServer", () => runSafely(() => server.start())),
    vscode.commands.registerCommand("seekforge.stopServer", () => runSafely(() => server.stop())),
    vscode.commands.registerCommand("seekforge.setToken", () =>
      runSafely(async () => {
        const token = await vscode.window.showInputBox({
          prompt: "Bearer token printed by seekforge serve (leave empty to clear)",
          password: true,
          ignoreFocusOut: true,
        });
        if (token === undefined) return;
        await writeStoredToken(context.secrets, token.trim());
        void vscode.window.showInformationMessage(
          token.trim() ? "SeekForge token saved securely." : "SeekForge token cleared.",
        );
      }),
    ),
    vscode.commands.registerCommand("seekforge.reviewMemory", () =>
      runSafely(async () => {
        // Remembering a fact is a human decision by design. Making that decision
        // where the code is beats switching apps to make it.
        const { bridge, workspaceId } = await connected(context, "reviewing SeekForge memory");
        if (!bridge) return;
        const pending = await bridge.pendingMemory(workspaceId);
        if (pending.length === 0) {
          void vscode.window.showInformationMessage("No SeekForge memory candidates are waiting for review.");
          return;
        }
        const picked = await vscode.window.showQuickPick(
          pending.map((candidate) => ({
            label: candidate.text,
            description: candidate.type,
            detail: candidate.source ? `from ${candidate.source}` : undefined,
            candidate,
          })),
          { placeHolder: `${pending.length} fact(s) waiting — pick one to decide` },
        );
        if (!picked) return;
        const decision = await vscode.window.showQuickPick(
          [
            { label: "Approve", detail: "Inject this fact into future sessions", value: "approve" },
            { label: "Reject", detail: "Discard it", value: "reject" },
          ],
          { placeHolder: picked.candidate.text },
        );
        if (!decision) return;
        await bridge.decideMemory(workspaceId, picked.candidate.id, decision.value);
        void vscode.window.showInformationMessage(`SeekForge memory ${decision.value}d.`);
      }),
    ),
    vscode.commands.registerCommand("seekforge.showSession", () =>
      runSafely(async () => {
        const { bridge, workspaceId } = await connected(context, "opening a SeekForge session");
        if (!bridge) return;
        const sessions = await bridge.sessions(workspaceId);
        if (sessions.length === 0) {
          void vscode.window.showInformationMessage("No SeekForge sessions recorded for this workspace yet.");
          return;
        }
        const picked = await vscode.window.showQuickPick(
          sessions.map((session) => ({ label: session.task ?? session.id, description: session.id, session })),
          { placeHolder: "Open a SeekForge session transcript" },
        );
        if (!picked) return;
        const { meta, messages } = await bridge.sessionTranscript(workspaceId, picked.session.id);
        const document = await vscode.workspace.openTextDocument({
          language: "markdown",
          content: formatTranscript(meta, messages),
        });
        await vscode.window.showTextDocument(document, { preview: true });
      }),
    ),
    vscode.commands.registerCommand("seekforge.showDiff", () =>
      runSafely(async () => {
        const { bridge, workspaceId } = await connected(context, "showing a SeekForge diff");
        if (!bridge) return;
        const result = await bridge.request(withWorkspace("/api/diff", workspaceId));
        const document = await vscode.workspace.openTextDocument({
          language: "diff",
          content: result.diff || "No changes.",
        });
        await vscode.window.showTextDocument(document, { preview: true });
      }),
    ),
  );
}

async function deactivate() {
  const tasks = deactivateTasks;
  deactivateTasks = [];
  await Promise.allSettled(tasks.map((task) => task()));
}

module.exports = { activate, deactivate };
