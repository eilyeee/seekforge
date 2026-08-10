const vscode = require("vscode");
const WebSocket = require("ws");
const {
  SeekForgeBridge,
  formatAgentEvent,
  formatLoopReport,
  formatTranscript,
  hasDiffPreview,
  loopRow,
  permissionHunkItems,
  permissionSummary,
  readStoredToken,
  taskWithEditorContext,
  usageSummary,
  withWorkspace,
  writeStoredToken,
  workspaceRootForEditor,
} = require("./bridge.cjs");

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
  return new SeekForgeBridge({
    serverUrl: config.get("serverUrl", "http://127.0.0.1:3847"),
    token,
    WebSocketImpl: WebSocket,
  });
}

/**
 * Modal dialogs elide long text, so the diff goes to a real editor document and
 * the modal keeps only the raw command/path the approval actually grants.
 */
async function reviewPermission(request) {
  if (hasDiffPreview(request)) {
    const document = await vscode.workspace.openTextDocument({ language: "diff", content: request.preview.diff });
    await vscode.window.showTextDocument(document, {
      preview: true,
      preserveFocus: true,
      viewColumn: vscode.ViewColumn.Beside,
    });
  }
  const hunks = permissionHunkItems(request);
  // "Always allow" appears only when core proposed a rule, and the rule itself
  // is in the modal detail: a frontend must never offer a persistence whose
  // text it made up.
  const choice = await vscode.window.showWarningMessage(
    request.description,
    { modal: true, detail: permissionSummary(request) },
    ...(hunks.length > 0 ? ["Allow selected edits…"] : []),
    "Allow once",
    "Allow for session",
    ...(request?.rememberRule ? ["Always allow"] : []),
    "Reject",
  );
  if (choice === "Always allow") return { approved: true, remember: "always" };
  if (choice === "Allow for session") return { approved: true, remember: "session" };
  if (choice === "Allow once") return { approved: true };
  if (choice !== "Allow selected edits…") return { approved: false };

  const picked = await vscode.window.showQuickPick(hunks, {
    canPickMany: true,
    placeHolder: `Apply which of the ${hunks.length} edits?`,
  });
  // An empty or dismissed selection applies nothing, so it must not read as approval.
  if (!picked || picked.length === 0) return { approved: false };
  return { approved: true, selectedHunks: picked.map((item) => item.index) };
}

async function runTask(context, output, statusBar, options = {}) {
  const { resumeSessionId } = options;
  const workspaceRoot =
    options.workspaceRoot ?? workspaceRootForEditor(vscode.workspace, vscode.window.activeTextEditor);
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage("Open a workspace folder before starting SeekForge.");
    return;
  }
  const prompt = await vscode.window.showInputBox({ prompt: resumeSessionId ? "Follow-up task" : "SeekForge task" });
  if (!prompt) return;
  const mode = await vscode.window.showQuickPick(["ask", "edit"], { placeHolder: "Run mode" });
  if (!mode) return;

  const bridge = await configuredBridge(context);
  const workspaceId = options.workspaceId ?? (await bridge.workspaceId(workspaceRoot));
  const task = taskWithEditorContext(prompt, vscode.window.activeTextEditor, workspaceRoot);
  const frame = resumeSessionId
    ? {
        type: "send",
        sessionId: resumeSessionId,
        task,
        mode,
        approvalMode: "confirm",
        ws: workspaceId,
      }
    : { type: "start", task, mode, approvalMode: "confirm", ws: workspaceId };

  output.clear();
  output.show(true);
  output.appendLine(`> ${prompt}\n`);
  statusBar.startRun();
  await vscode.window
    .withProgress(
      { location: vscode.ProgressLocation.Notification, title: "SeekForge is running…", cancellable: true },
      (progress, cancellationToken) => {
        const controller = new AbortController();
        const cancellation = cancellationToken.onCancellationRequested(() => controller.abort());
        return bridge
          .run(
            frame,
            async (message, reply) => {
              if (message.type === "permission.request") {
                const decision = await reviewPermission(message.request);
                reply({ type: "permission.response", requestId: message.requestId, ...decision });
                return;
              }
              if (message.type === "question.request") {
                const answer = await vscode.window.showQuickPick(message.options, { placeHolder: message.question });
                reply({ type: "question.answer", id: message.id, answer: answer ?? "" });
                return;
              }
              if (message.type !== "event") return;
              const event = message.event;
              if (event.type === "model.delta") {
                output.append(event.chunk);
                return;
              }
              if (event.type === "reasoning.delta") {
                output.append(`[thinking] ${event.chunk}`);
                return;
              }
              if (event.type === "command.output") {
                output.append(event.chunk);
                return;
              }
              if (event.type === "usage.updated") {
                statusBar.reportUsage(event.usage);
                return;
              }
              if (event.type === "step.started") {
                progress.report({ message: event.title });
                return;
              }
              const line = formatAgentEvent(event);
              if (line !== null) output.appendLine(line);
              if (event.type === "session.completed") statusBar.reportUsage(event.report?.usage);
            },
            { signal: controller.signal },
          )
          .finally(() => cancellation.dispose());
      },
    )
    .then(
      () => statusBar.endRun(),
      (error) => {
        statusBar.endRun();
        throw error;
      },
    );
}

/**
 * A persistent cost/token readout: DeepSeek cache-hit accounting is a product
 * guarantee, so a run's spend stays visible after the notification disappears.
 */
function createStatusBar() {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = "seekforge.showOutput";
  let lastUsage;
  const render = (running) => {
    const usage = lastUsage ? usageSummary(lastUsage) : "";
    item.text = running ? "$(sync~spin) SeekForge" : usage ? `$(check) SeekForge` : "$(rocket) SeekForge";
    item.tooltip = usage ? `SeekForge — ${usage}` : "SeekForge: no run yet";
    if (usage) item.text += ` ${usage.split(" · ")[0]}`;
    item.show();
  };
  render(false);
  return {
    item,
    startRun() {
      lastUsage = undefined;
      render(true);
    },
    reportUsage(usage) {
      if (usage) lastUsage = usage;
      render(true);
    },
    endRun() {
      render(false);
    },
    dispose() {
      item.dispose();
    },
  };
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

function activate(context) {
  const output = vscode.window.createOutputChannel("SeekForge");
  const statusBar = createStatusBar();
  const loopsView = createLoopsView(context);
  context.subscriptions.push(
    output,
    statusBar,
    loopsView,
    vscode.window.registerTreeDataProvider("seekforge.loops", loopsView.provider),
    vscode.commands.registerCommand("seekforge.refreshLoops", () => loopsView.refresh()),
    vscode.commands.registerCommand("seekforge.showLoop", (target) => runSafely(() => openLoopReport(context, target))),
    vscode.commands.registerCommand("seekforge.showOutput", () => output.show(true)),
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
    vscode.commands.registerCommand("seekforge.newTask", () => runSafely(() => runTask(context, output, statusBar))),
    vscode.commands.registerCommand("seekforge.resumeSession", () =>
      runSafely(async () => {
        const bridge = await configuredBridge(context);
        const workspaceRoot = workspaceRootForEditor(vscode.workspace, vscode.window.activeTextEditor);
        if (!workspaceRoot) {
          void vscode.window.showErrorMessage("Open a workspace folder before resuming a SeekForge session.");
          return;
        }
        const workspaceId = await bridge.workspaceId(workspaceRoot);
        const sessions = await bridge.request(withWorkspace("/api/sessions", workspaceId));
        const picked = await vscode.window.showQuickPick(
          sessions.map((session) => ({ label: session.task, description: session.id, session })),
          { placeHolder: "Resume a SeekForge session" },
        );
        if (picked) {
          await runTask(context, output, statusBar, {
            resumeSessionId: picked.session.id,
            workspaceRoot,
            workspaceId,
          });
        }
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
        const bridge = await configuredBridge(context);
        const workspaceRoot = workspaceRootForEditor(vscode.workspace, vscode.window.activeTextEditor);
        if (!workspaceRoot) {
          void vscode.window.showErrorMessage("Open a workspace folder before showing a SeekForge diff.");
          return;
        }
        const workspaceId = await bridge.workspaceId(workspaceRoot);
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

function deactivate() {}

module.exports = { activate, deactivate };
