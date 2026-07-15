/**
 * MCP server mode — exposes SeekForge's builtin tools to OTHER agents over
 * newline-delimited JSON-RPC 2.0 on stdio (the exact framing client.ts
 * speaks, so any MCP client — including SeekForge itself — can connect).
 *
 * Trust model
 * -----------
 * There is no human on the other end of this transport, so permission
 * prompts cannot exist; the `confirm` channel is replaced by policy:
 *
 * - readOnly (DEFAULT): only the read-only subset (read_file, list_files,
 *   search_text, git_status, git_diff) is advertised or callable, the
 *   ToolContext runs in "ask" mode (everything above L0 is forbidden), and
 *   confirm auto-DENIES — three independent layers against writes.
 * - readOnly:false (FULL access — trusted callers only): every builtin tool
 *   except ask_user (no interactive channel) is advertised, and confirm
 *   auto-allows L1 (write) and L2 (execute). L3 "env" requests (web tools,
 *   dependency installs) are still auto-DENIED — they always require a real
 *   human. Only wire full mode to callers you would trust with a shell.
 */

import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { createDefaultDispatcher, type ToolContext } from "../tools/index.js";

/** Must match what our own client sends (client.ts PROTOCOL_VERSION). */
const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "seekforge", version: "0.7.0" };
const WORKSPACE_OVERVIEW_URI = "seekforge://workspace/overview";
const WORKSPACE_STATUS_URI = "seekforge://workspace/status";

const SERVER_PROMPTS = [
  {
    name: "review-changes",
    description: "Review the current workspace changes for correctness, security, and missing tests.",
  },
  {
    name: "security-review",
    description: "Threat-model and audit a workspace area supplied as the focus argument.",
    arguments: [{ name: "focus", description: "Optional path, feature, or trust boundary to prioritize.", required: false }],
  },
] as const;

/** Tools exposed in read-only mode (all classify as L0 readonly). */
export const MCP_READONLY_TOOLS = [
  "read_file",
  "list_files",
  "search_text",
  "git_status",
  "git_diff",
] as const;

export type ServeMcpOptions = {
  /** Absolute path of the workspace all tool calls are sandboxed to. */
  workspace: string;
  /** Default true. false = full tool set for TRUSTED callers only. */
  readOnly?: boolean;
  /** Defaults to process.stdin / process.stdout. */
  input?: Readable;
  output?: Writable;
};

export type McpServerHandle = {
  /** Stops reading input and aborts in-flight tool calls. */
  close(): void;
};

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
};

export function serveMcp(opts: ServeMcpOptions): McpServerHandle {
  const readOnly = opts.readOnly !== false;
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  const dispatcher = createDefaultDispatcher();
  const exposed = new Set<string>(
    readOnly
      ? MCP_READONLY_TOOLS
      : dispatcher
          .list()
          .map((t) => t.name)
          // ask_user blocks on a human answer channel that MCP does not carry.
          .filter((name) => name !== "ask_user"),
  );

  // One long-lived ToolContext for the whole connection. See the trust-model
  // note above: "ask" mode + auto-deny in readOnly; auto-allow L1/L2 in full.
  const ctx: ToolContext = {
    sessionId: `mcp-${Date.now().toString(36)}`,
    workspace: opts.workspace,
    policy: {
      approvalMode: "confirm",
      mode: readOnly ? "ask" : "edit",
      commandAllowlist: [],
    },
    confirm: async (req) =>
      !readOnly && (req.permission === "write" || req.permission === "execute"),
  };

  let closed = false;
  let lifecycle: "new" | "initializing" | "ready" = "new";
  let nextCallId = 1;
  const inflight = new Map<number | string, AbortController>();

  const write = (msg: Record<string, unknown>): void => {
    if (closed) return;
    output.write(`${JSON.stringify(msg)}\n`);
  };
  const respond = (id: JsonRpcMessage["id"], result: unknown): void => {
    if (id === undefined || id === null) return; // notification: never answer
    write({ jsonrpc: "2.0", id, result });
  };
  const respondError = (id: JsonRpcMessage["id"], code: number, message: string): void => {
    if (id === undefined || id === null) return;
    write({ jsonrpc: "2.0", id, error: { code, message } });
  };

  const listToolsResult = (): unknown => ({
    tools: dispatcher
      .list()
      .filter((t) => exposed.has(t.name))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
  });

  const listResourcesResult = (): unknown => ({
    resources: [
      { uri: WORKSPACE_OVERVIEW_URI, name: "Workspace overview", mimeType: "application/json" },
      { uri: WORKSPACE_STATUS_URI, name: "Git status", mimeType: "application/json" },
    ],
  });

  async function readResource(
    id: JsonRpcMessage["id"],
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    const uri = params["uri"];
    if (uri === WORKSPACE_OVERVIEW_URI) {
      respond(id, {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ workspace: opts.workspace, readOnly }) }],
      });
      return;
    }
    if (uri === WORKSPACE_STATUS_URI) {
      const result = await dispatcher.execute(
        { id: `mcp-call-${nextCallId++}`, name: "git_status", arguments: {} },
        { ...ctx, ...(signal ? { signal } : {}) },
      );
      if (!result.ok) {
        respondError(id, -32603, result.error?.message ?? "git_status failed");
        return;
      }
      respond(id, {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result.data ?? null) }],
      });
      return;
    }
    respondError(id, -32602, `Unknown resource: ${String(uri)}`);
  }

  function getPrompt(id: JsonRpcMessage["id"], params: Record<string, unknown>): void {
    const name = params["name"];
    const args = typeof params["arguments"] === "object" && params["arguments"] !== null && !Array.isArray(params["arguments"])
      ? params["arguments"] as Record<string, unknown>
      : {};
    if (name === "review-changes") {
      respond(id, { messages: [{ role: "user", content: { type: "text", text: "Review all current workspace changes. Prioritize correctness, security regressions, boundary cases, and missing tests. Report findings by severity with file references." } }] });
      return;
    }
    if (name === "security-review") {
      const focus = typeof args["focus"] === "string" && args["focus"].trim() ? ` Focus on: ${args["focus"].trim()}.` : "";
      respond(id, { messages: [{ role: "user", content: { type: "text", text: `Threat-model and audit this workspace. Identify assets, trust boundaries, attack paths, concrete vulnerabilities, and mitigations.${focus}` } }] });
      return;
    }
    respondError(id, -32602, `Unknown prompt: ${String(name)}`);
  }

  async function callTool(
    id: JsonRpcMessage["id"],
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    const name = typeof params["name"] === "string" ? params["name"] : "";
    if (!name) {
      respondError(id, -32602, "Missing tool name");
      return;
    }
    if (!exposed.has(name)) {
      respondError(
        id,
        -32602,
        readOnly ? `Tool not available in read-only mode: ${name}` : `Tool not exposed: ${name}`,
      );
      return;
    }
    const args = params["arguments"] ?? {};
    const result = await dispatcher.execute(
      { id: `mcp-call-${nextCallId++}`, name, arguments: args },
      { ...ctx, ...(signal ? { signal } : {}) },
    );
    const text = result.ok
      ? JSON.stringify(result.data ?? null)
      : `${result.error?.code ?? "error"}: ${result.error?.message ?? "tool failed"}`;
    respond(id, { content: [{ type: "text", text }], isError: !result.ok });
  }

  async function handle(msg: JsonRpcMessage): Promise<void> {
    const method = msg.method;
    if (typeof method !== "string") return; // a response/garbage: ignore
    const id = msg.id;
    const params = msg.params ?? {};
    if (method === "initialize") {
      if (lifecycle !== "new") {
        respondError(id, -32600, "initialize may only be sent once");
        return;
      }
      lifecycle = "initializing";
      respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {}, resources: {}, prompts: {} },
      });
      return;
    }
    if (method === "notifications/initialized") {
      if (lifecycle === "initializing") lifecycle = "ready";
      return;
    }
    if (lifecycle !== "ready") {
      respondError(id, -32002, lifecycle === "new" ? "server is not initialized" : "initialization not completed");
      return;
    }
    switch (method) {
      case "ping":
        respond(id, {});
        return;
      case "tools/list":
        respond(id, listToolsResult());
        return;
      case "tools/call":
        // dispatcher.execute normally reports tool failures as ok:false, but an
        // unexpected throw must still yield a JSON-RPC error — otherwise the
        // client gets no response and blocks until its per-request timeout.
        if (id === undefined || id === null) {
          await callTool(id, params);
          return;
        }
        {
          const controller = new AbortController();
          inflight.set(id, controller);
          try {
            await callTool(id, params, controller.signal);
          } catch (err) {
            respondError(id, -32603, `Internal error: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            if (inflight.get(id) === controller) inflight.delete(id);
          }
        }
        return;
      case "notifications/cancelled": {
        const requestId = params["requestId"];
        if (typeof requestId === "number" || typeof requestId === "string") {
          inflight.get(requestId)?.abort();
        }
        return;
      }
      case "resources/list":
        respond(id, listResourcesResult());
        return;
      case "resources/read":
        if (id === undefined || id === null) {
          await readResource(id, params);
          return;
        }
        {
          const controller = new AbortController();
          inflight.set(id, controller);
          try {
            await readResource(id, params, controller.signal);
          } catch (err) {
            respondError(id, -32603, `Internal error: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            if (inflight.get(id) === controller) inflight.delete(id);
          }
        }
        return;
      case "prompts/list":
        respond(id, { prompts: SERVER_PROMPTS });
        return;
      case "prompts/get":
        getPrompt(id, params);
        return;
      default:
        respondError(id, -32601, `Method not found: ${method}`);
    }
  }

  const rl: Interface = createInterface({ input });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return; // not protocol traffic; tolerate (mirrors the client)
    }
    if (msg === null || typeof msg !== "object") return;
    // JSON-RPC request ids make out-of-order responses unambiguous. Dispatch
    // independently so a long tool call cannot block ping/tools/list/cancel.
    void handle(msg).catch(() => {
      // Request handlers report their own errors when an id is present.
    });
  });

  return {
    close(): void {
      closed = true;
      for (const controller of inflight.values()) controller.abort();
      inflight.clear();
      rl.close();
    },
  };
}
