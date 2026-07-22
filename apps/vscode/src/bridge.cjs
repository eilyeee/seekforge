const fs = require("node:fs");
const path = require("node:path");

const MAX_SELECTION_CHARS = 20_000;

function websocketUrl(serverUrl, token) {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  url.search = token ? `?token=${encodeURIComponent(token)}` : "";
  return url.toString();
}

function withWorkspace(pathname, workspaceId) {
  if (!workspaceId) return pathname;
  const separator = pathname.includes("?") ? "&" : "?";
  return `${pathname}${separator}ws=${encodeURIComponent(workspaceId)}`;
}

function canonicalWorkspacePath(workspacePath) {
  let resolved = path.resolve(workspacePath);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // The server may report a path that disappeared after it started.
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function workspaceRootForEditor(workspaceApi, editor) {
  const uri = editor?.document?.uri;
  const active = uri && workspaceApi?.getWorkspaceFolder?.(uri);
  return active?.uri?.fsPath ?? workspaceApi?.workspaceFolders?.[0]?.uri?.fsPath;
}

function taskWithEditorContext(task, editor, workspaceRoot) {
  if (!editor || !workspaceRoot) return task;
  const file = editor.document?.uri?.fsPath;
  if (typeof file !== "string") return task;
  const relative = path.relative(workspaceRoot, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return task;
  const selected = editor.document.getText(editor.selection).slice(0, MAX_SELECTION_CHARS);
  const context = selected ? `\nSelected text from @${relative}:\n\n${selected}` : `\nContext: @${relative}`;
  return `${task.trim()}${context}`;
}

function permissionDetail(request) {
  return [
    request.description,
    request.command ? `\nRaw command:\n${request.command}` : "",
    request.path ? `\nRaw path:\n${request.path}` : "",
    request.preview?.diff ? `\nProposed diff:\n${request.preview.diff}` : "",
  ].join("");
}

class SeekForgeBridge {
  constructor({ serverUrl, token, WebSocketImpl, fetchImpl = fetch }) {
    this.serverUrl = serverUrl.replace(/\/$/, "");
    this.token = token;
    this.WebSocketImpl = WebSocketImpl;
    this.fetchImpl = fetchImpl;
  }

  async request(pathname) {
    const response = await this.fetchImpl(`${this.serverUrl}${pathname}`, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    });
    if (!response.ok) throw new Error(`SeekForge HTTP ${response.status}`);
    return response.json();
  }

  async workspaceId(workspacePath) {
    if (!workspacePath) throw new Error("Open a workspace folder before connecting to SeekForge");
    const body = await this.request("/api/workspaces");
    const wanted = canonicalWorkspacePath(workspacePath);
    const match = body.workspaces?.find(
      (workspace) => typeof workspace.path === "string" && canonicalWorkspacePath(workspace.path) === wanted,
    );
    if (typeof match?.id !== "string" || match.id.length === 0) {
      throw new Error(`SeekForge server does not host the VS Code workspace: ${workspacePath}`);
    }
    return match.id;
  }

  run(frame, onFrame) {
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(websocketUrl(this.serverUrl, this.token));
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        socket.close();
        if (error) reject(error);
        else resolve();
      };
      socket.on("open", () => socket.send(JSON.stringify(frame)));
      socket.on("message", async (data) => {
        let message;
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        try {
          await onFrame(message, (reply) => socket.send(JSON.stringify(reply)));
        } catch (error) {
          finish(error);
          return;
        }
        if (message.type === "idle") finish();
        if (message.type === "error") finish(new Error(message.message));
      });
      socket.on("error", (error) => finish(error));
      socket.on("close", () => {
        if (!settled) finish(new Error("SeekForge WebSocket closed before the run completed"));
      });
    });
  }
}

module.exports = {
  MAX_SELECTION_CHARS,
  SeekForgeBridge,
  permissionDetail,
  taskWithEditorContext,
  websocketUrl,
  withWorkspace,
  workspaceRootForEditor,
};
