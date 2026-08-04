const fs = require("node:fs");
const path = require("node:path");

const MAX_SELECTION_CHARS = 20_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
/** Tool rows are activity, not transcripts: keep one line readable in the panel. */
const MAX_EVENT_LINE_CHARS = 400;

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

/**
 * The raw command/path an approval actually grants. Modal dialogs elide long
 * text, so the diff is shown in its own editor document instead of inlined here
 * — but the raw strings must always stay in front of the approver.
 */
function permissionSummary(request) {
  return [
    request.description,
    request.command ? `\nRaw command:\n${request.command}` : "",
    request.path ? `\nRaw path:\n${request.path}` : "",
  ].join("");
}

/** True when the request carries a diff worth opening in its own document. */
function hasDiffPreview(request) {
  return typeof request?.preview?.diff === "string" && request.preview.diff.length > 0;
}

/** Per-hunk picker rows for multi-hunk apply_patch approvals. */
function permissionHunkItems(request) {
  const hunks = Array.isArray(request?.hunks) ? request.hunks : [];
  if (hunks.length < 2) return [];
  return hunks.map((hunk) => ({
    label: `Hunk ${hunk.index + 1}`,
    detail: clipLine(hunk.preview, 200),
    index: hunk.index,
    picked: true,
  }));
}

function clipLine(text, max = MAX_EVENT_LINE_CHARS) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  // Array.from splits by code point, so clipping never severs a surrogate pair.
  const points = Array.from(flat);
  return points.length <= max ? flat : `${points.slice(0, max).join("")}…`;
}

/** The single most identifying argument of a tool call, for the activity row. */
function toolArgsSummary(args) {
  if (!args || typeof args !== "object") return "";
  for (const key of ["command", "path", "file_path", "pattern", "query", "url", "agentId", "id"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return clipLine(value, 160);
  }
  try {
    return clipLine(JSON.stringify(args), 160);
  } catch {
    return "";
  }
}

function toolResultSummary(result) {
  if (!result || typeof result !== "object") return "";
  if (result.ok === false) {
    return `error: ${clipLine(result.error?.message ?? result.error?.code ?? "failed", 200)}`;
  }
  const data = result.data;
  if (typeof data === "string") return clipLine(data, 200);
  if (data === undefined || data === null) return "ok";
  try {
    return clipLine(JSON.stringify(data), 200);
  } catch {
    return "ok";
  }
}

function formatTokens(count) {
  const value = Number(count) || 0;
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

/** Cost first: DeepSeek cache-hit accounting is a first-class part of the product. */
function usageSummary(usage) {
  if (!usage || typeof usage !== "object") return "";
  const cached = Number(usage.cacheHitTokens) || 0;
  const prompt = `${formatTokens(usage.promptTokens)} prompt${cached ? ` (${formatTokens(cached)} cached)` : ""}`;
  return `$${(Number(usage.costUsd) || 0).toFixed(4)} · ${prompt} · ${formatTokens(usage.completionTokens)} completion`;
}

/**
 * Renders one agent event as an output-channel line, or null when the event
 * carries no standalone row (streamed deltas and usage updates are handled by
 * the caller, which appends them without a line break or shows them elsewhere).
 */
function formatAgentEvent(event) {
  if (!event || typeof event.type !== "string") return null;
  switch (event.type) {
    case "tool.started":
      return `⏺ ${event.toolName}(${toolArgsSummary(event.args)})`;
    case "tool.completed":
      return `  ⎿ ${toolResultSummary(event.result) || "ok"}`;
    case "file.changed":
      return `  ± ${event.path}`;
    case "notice":
      return `${event.level === "warn" ? "!" : "i"} ${clipLine(event.message)}`;
    case "context.compacted":
      return `  ⎿ context compacted (${event.droppedTurns} turns, ${formatTokens(event.summaryTokens)} summary tokens)`;
    case "context.microcompacted":
      return `  ⎿ context micro-compacted (${event.clearedResults} tool results cleared)`;
    case "provider.retry":
      return `⟳ provider retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms — ${clipLine(event.reason, 120)}`;
    case "subagent.started":
      return `⏺ subagent ${event.agentId}: ${clipLine(event.task, 160)}`;
    case "subagent.step":
      return `  ⎿ subagent ${event.agentId} → ${event.toolName}`;
    case "subagent.completed":
      return `  ⎿ subagent ${event.agentId} done: ${clipLine(event.resultSummary, 200)}`;
    case "subagent.failed":
      return `  ⎿ subagent ${event.agentId} failed: ${clipLine(event.error?.message ?? "failed", 200)}`;
    case "subagent.cancelled":
      return `  ⎿ subagent ${event.agentId} cancelled: ${clipLine(event.reason, 160)}`;
    case "session.created":
      return `\nSession: ${event.sessionId}\n`;
    case "session.completed": {
      const report = event.report ?? {};
      const changed = Array.isArray(report.changedFiles) ? report.changedFiles : [];
      return [
        "",
        `⏺ ${clipLine(report.summary, 600)}`,
        changed.length > 0 ? `  ⎿ changed: ${changed.join(", ")}` : "",
        report.verification ? `  ⎿ verification: ${clipLine(report.verification, 200)}` : "",
        `  ⎿ usage: ${usageSummary(report.usage)}`,
      ]
        .filter((line) => line !== "")
        .join("\n");
    }
    case "session.failed":
      return `\nError: ${clipLine(event.error?.message ?? "run failed", 400)}`;
    default:
      return null;
  }
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

  /**
   * One REST call. `method`/`body` are for the few routes that change something
   * (approving a remembered fact); everything else is a plain GET.
   */
  async request(pathname, options = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(abortError("SeekForge request timed out")), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.serverUrl}${pathname}`, {
        method: options.method ?? "GET",
        headers: {
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
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

  /**
   * Facts waiting for a human decision. Memory is human-gated by design, so the
   * queue is only useful where the reviewer already is — which, while coding,
   * is the editor rather than another app.
   */
  async pendingMemory(workspaceId, options = {}) {
    const body = await this.request(withWorkspace("/api/memory", workspaceId), options);
    const candidates = Array.isArray(body?.candidates) ? body.candidates : [];
    return candidates.filter((candidate) => candidate?.status === "pending");
  }

  async decideMemory(workspaceId, id, decision, options = {}) {
    if (decision !== "approve" && decision !== "reject") throw new Error(`Unknown memory decision: ${decision}`);
    return this.request(withWorkspace(`/api/memory/${encodeURIComponent(id)}/${decision}`, workspaceId), {
      ...options,
      method: "POST",
    });
  }

  async sessions(workspaceId, options = {}) {
    const body = await this.request(withWorkspace("/api/sessions", workspaceId), options);
    return Array.isArray(body?.sessions) ? body.sessions : [];
  }

  /** One session's transcript, as the messages a reader would want to see. */
  async sessionTranscript(workspaceId, id, options = {}) {
    const body = await this.request(withWorkspace(`/api/sessions/${encodeURIComponent(id)}`, workspaceId), options);
    return {
      meta: body?.meta ?? {},
      messages: Array.isArray(body?.messages) ? body.messages : [],
    };
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

/**
 * Render a transcript for reading, not for replay: roles as headers, tool calls
 * named rather than dumped. A reviewer opening a past session wants to see what
 * happened, and the raw JSONL is the thing they were trying to avoid.
 */
function formatTranscript(meta, messages) {
  const lines = [`# ${meta?.title || meta?.id || "SeekForge session"}`];
  if (meta?.createdAt) lines.push(`_${meta.createdAt}_`);
  for (const message of messages) {
    const role = String(message?.role ?? "");
    if (role === "system") continue; // the prompt, not the conversation
    const calls = Array.isArray(message?.toolCalls) ? message.toolCalls : [];
    const header = role === "tool" ? "tool result" : role;
    lines.push("", `## ${header}`);
    const content = typeof message?.content === "string" ? message.content : "";
    if (content) lines.push(content);
    for (const call of calls) lines.push(`- called \`${call?.name ?? "?"}\``);
    const images = Array.isArray(message?.images) ? message.images : [];
    // The bytes are not printable, but their absence would misrepresent the
    // turn: the model saw something this reader cannot.
    for (const image of images) lines.push(`- [image attached: ${image?.label ?? image?.mediaType ?? "image"}]`);
  }
  return lines.join("\n");
}

module.exports = {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  MAX_EVENT_LINE_CHARS,
  MAX_SELECTION_CHARS,
  SeekForgeBridge,
  clipLine,
  formatAgentEvent,
  formatTranscript,
  hasDiffPreview,
  normalizeServerUrl,
  permissionHunkItems,
  permissionSummary,
  usageSummary,
  readStoredToken,
  taskWithEditorContext,
  websocketUrl,
  withWorkspace,
  writeStoredToken,
  workspaceRootForEditor,
};
