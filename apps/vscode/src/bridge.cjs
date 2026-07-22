const fs = require("node:fs");
const path = require("node:path");

const MAX_SELECTION_CHARS = 20_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;

function normalizeServerUrl(serverUrl) {
  const url = new URL(serverUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SeekForge server URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("SeekForge server URL must not include credentials");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function websocketUrl(serverUrl, token) {
  const url = new URL(normalizeServerUrl(serverUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  url.search = token ? `?token=${encodeURIComponent(token)}` : "";
  return url.toString();
}

function abortError(message) {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

async function readStoredToken(secretStorage, legacyToken = "") {
  const stored = await secretStorage.get("seekforge.token");
  if (stored) return stored;
  if (!legacyToken) return "";
  await secretStorage.store("seekforge.token", legacyToken);
  return legacyToken;
}

async function writeStoredToken(secretStorage, token) {
  if (token) await secretStorage.store("seekforge.token", token);
  else await secretStorage.delete("seekforge.token");
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
  constructor({
    serverUrl,
    token,
    WebSocketImpl,
    fetchImpl = fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  }) {
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.token = token;
    this.WebSocketImpl = WebSocketImpl;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.runTimeoutMs = runTimeoutMs;
  }

  async request(pathname, options = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(abortError("SeekForge request timed out")), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.serverUrl}${pathname}`, {
        headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`SeekForge HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw abortError("SeekForge request was cancelled or timed out");
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
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

  run(frame, onFrame, options = {}) {
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(websocketUrl(this.serverUrl, this.token));
      let settled = false;
      let opened = false;
      const timer = setTimeout(() => finish(abortError("SeekForge run timed out")), this.runTimeoutMs);
      const onAbort = () => {
        if (opened) {
          try {
            socket.send(JSON.stringify({ type: "cancel" }));
          } catch {
            // Closing below still releases the local connection.
          }
        }
        finish(abortError("SeekForge run cancelled"));
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        socket.close();
        if (error) reject(error);
        else resolve();
      };
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      socket.on("open", () => {
        opened = true;
        socket.send(JSON.stringify(frame));
      });
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
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  MAX_SELECTION_CHARS,
  SeekForgeBridge,
  normalizeServerUrl,
  permissionDetail,
  readStoredToken,
  taskWithEditorContext,
  websocketUrl,
  withWorkspace,
  writeStoredToken,
  workspaceRootForEditor,
};
