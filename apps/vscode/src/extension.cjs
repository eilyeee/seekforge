const vscode = require("vscode");
const WebSocket = require("ws");
const {
  SeekForgeBridge,
  formatAgentEvent,
  hasDiffPreview,
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
  const choice = await vscode.window.showWarningMessage(
    request.description,
    { modal: true, detail: permissionSummary(request) },
    ...(hunks.length > 0 ? ["Allow selected edits…"] : []),
    "Allow once",
    "Allow for session",
    "Reject",
  );
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

function activate(context) {
  const output = vscode.window.createOutputChannel("SeekForge");
  const statusBar = createStatusBar();
  context.subscriptions.push(
    output,
    statusBar,
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
