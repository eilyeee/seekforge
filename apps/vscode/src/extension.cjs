const vscode = require("vscode");
const WebSocket = require("ws");
const {
  SeekForgeBridge,
  permissionDetail,
  taskWithEditorContext,
  withWorkspace,
  workspaceRootForEditor,
} = require("./bridge.cjs");

function configuredBridge() {
  const config = vscode.workspace.getConfiguration("seekforge");
  return new SeekForgeBridge({
    serverUrl: config.get("serverUrl", "http://127.0.0.1:3847"),
    token: config.get("token", ""),
    WebSocketImpl: WebSocket,
  });
}

async function runTask(output, options = {}) {
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

  const bridge = configuredBridge();
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
    { location: vscode.ProgressLocation.Notification, title: "SeekForge is running…" },
    () =>
      bridge.run(frame, async (message, reply) => {
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
      }),
  );
}

function activate(context) {
  const output = vscode.window.createOutputChannel("SeekForge");
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("seekforge.newTask", () => runTask(output)),
    vscode.commands.registerCommand("seekforge.resumeSession", async () => {
      const bridge = configuredBridge();
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
        await runTask(output, { resumeSessionId: picked.session.id, workspaceRoot, workspaceId });
      }
    }),
    vscode.commands.registerCommand("seekforge.showDiff", async () => {
      const bridge = configuredBridge();
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
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
