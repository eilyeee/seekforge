const vscode = require("vscode");
const WebSocket = require("ws");
const {
  SeekForgeBridge,
  permissionDetail,
  readStoredToken,
  taskWithEditorContext,
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

async function runTask(context, output, options = {}) {
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
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "SeekForge is running…", cancellable: true },
    (_progress, cancellationToken) => {
      const controller = new AbortController();
      const cancellation = cancellationToken.onCancellationRequested(() => controller.abort());
      return bridge
        .run(
          frame,
          async (message, reply) => {
            if (message.type === "permission.request") {
              const choice = await vscode.window.showWarningMessage(
                permissionDetail(message.request),
                { modal: true },
                "Allow once",
                "Allow for session",
                "Reject",
              );
              reply({
                type: "permission.response",
                requestId: message.requestId,
                approved: choice === "Allow once" || choice === "Allow for session",
                ...(choice === "Allow for session" ? { remember: "session" } : {}),
              });
              return;
            }
            if (message.type === "question.request") {
              const answer = await vscode.window.showQuickPick(message.options, { placeHolder: message.question });
              reply({ type: "question.answer", id: message.id, answer: answer ?? "" });
              return;
            }
            if (message.type !== "event") return;
            if (message.event.type === "model.delta") output.append(message.event.chunk);
            else if (message.event.type === "reasoning.delta") output.append(`[thinking] ${message.event.chunk}`);
            else if (message.event.type === "session.created")
              output.appendLine(`\n\nSession: ${message.event.sessionId}\n`);
            else if (message.event.type === "session.failed")
              output.appendLine(`\n\nError: ${message.event.error.message}`);
          },
          { signal: controller.signal },
        )
        .finally(() => cancellation.dispose());
    },
  );
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
  context.subscriptions.push(
    output,
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
    vscode.commands.registerCommand("seekforge.newTask", () => runSafely(() => runTask(context, output))),
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
          await runTask(context, output, { resumeSessionId: picked.session.id, workspaceRoot, workspaceId });
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
