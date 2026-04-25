import type { McpClientOptions } from "./client.js";
import { McpError } from "./errors.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "seekforge", version: "0.3.0" };

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

/**
 * Extracts the JSON-RPC response with `id` from a `text/event-stream` body:
 * SSE events are parsed incrementally, the `data:` lines of each event are
 * joined and JSON-parsed, and reading stops at the first response whose id
 * matches (further events — server notifications/requests — are ignored).
 */
async function readSseResponse(body: ReadableStream<Uint8Array>, id: number): Promise<JsonRpcResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      // Events are separated by a blank line; tolerate \r\n line endings.
      for (;;) {
        const sep = buffer.search(/\n\n|\r\n\r\n/);
        if (sep === -1) break;
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + (buffer[sep] === "\r" ? 4 : 2));
        const data = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        let msg: JsonRpcResponse;
        try {
          msg = JSON.parse(data) as JsonRpcResponse;
        } catch {
          continue; // not JSON — ignore (e.g. keep-alive payloads)
        }
        if (msg !== null && typeof msg === "object" && msg.id === id && ("result" in msg || "error" in msg)) {
          return msg;
        }
      }
      if (done) throw new McpError("mcp_parse_error", `SSE stream ended without a response for request ${id}`);
    }
  } finally {
    // Stop reading once we have (or failed to get) the answer.
    await reader.cancel().catch(() => {});
  }
}

/**
 * MCP client over Streamable HTTP (one POST per JSON-RPC message), exposing
 * the same interface as the stdio client. Selected by `config.url`.
 *
 * - Every request POSTs to `url` with `content-type: application/json`,
 *   `accept: application/json, text/event-stream` and the configured
 *   `config.headers`.
 * - Both server response styles are handled: a plain JSON body, and a
 *   `text/event-stream` body (the SSE `data:` events are scanned for the
 *   response matching the request id, then the stream is dropped).
 * - The `mcp-session-id` response header, when present, is echoed on every
 *   subsequent request (and updated if the server rotates it).
 * - `notifications/initialized` is POSTed after a successful initialize.
 * - Requests time out after `requestTimeoutMs` (default 30s) via AbortController.
 *
 * Out of scope: full OAuth flows (authorization-code, token refresh). Static
 * `headers` cover bearer-token servers; servers needing interactive auth are
 * not supported. Server-initiated requests and standalone GET streams are
 * also not supported (matching the stdio client's v1 surface).
 */
export function createMcpHttpTransport(options: McpClientOptions): {
  request<T>(method: string, params: unknown): Promise<T>;
  dispose(): void;
} {
  const url = options.config.url;
  if (!url) throw new McpError("mcp_config", `MCP server "${options.name}" has no url`);
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  let sessionId: string | undefined;
  let handshake: Promise<void> | undefined;
  let nextId = 1;
  let disposed = false;
  const inflight = new Set<AbortController>();

  function headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...options.config.headers,
      ...(sessionId !== undefined ? { "mcp-session-id": sessionId } : {}),
    };
  }

  /** POSTs one JSON-RPC message; `id === undefined` marks a notification (response body ignored). */
  async function post(method: string, params: unknown, id: number | undefined): Promise<JsonRpcResponse> {
    if (disposed) throw new McpError("disposed", `MCP client "${options.name}" is disposed`);
    const controller = new AbortController();
    inflight.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetch(url!, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, params }),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw disposed
            ? new McpError("disposed", `MCP client "${options.name}" disposed`)
            : new McpError("mcp_timeout", `MCP server "${options.name}" did not answer ${method} within ${timeoutMs}ms`);
        }
        throw new McpError("mcp_http_error", `MCP server "${options.name}" unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
      const newSession = res.headers.get("mcp-session-id");
      if (newSession) sessionId = newSession;
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new McpError("mcp_http_error", `MCP server "${options.name}" answered ${method} with HTTP ${res.status}`);
      }
      if (id === undefined) {
        // Notification: typically 202 Accepted with an empty body.
        await res.body?.cancel().catch(() => {});
        return {};
      }
      const contentType = res.headers.get("content-type") ?? "";
      try {
        if (contentType.includes("text/event-stream")) {
          if (!res.body) throw new McpError("mcp_parse_error", "empty SSE body");
          return await readSseResponse(res.body, id);
        }
        const text = await res.text();
        return JSON.parse(text) as JsonRpcResponse;
      } catch (err) {
        if (err instanceof McpError) throw err;
        if (controller.signal.aborted && !disposed) {
          throw new McpError("mcp_timeout", `MCP server "${options.name}" did not answer ${method} within ${timeoutMs}ms`);
        }
        throw new McpError("mcp_parse_error", `MCP server "${options.name}" sent an unparseable ${method} response: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      clearTimeout(timer);
      inflight.delete(controller);
    }
  }

  async function rawRequest<T>(method: string, params: unknown): Promise<T> {
    const id = nextId++;
    const msg = await post(method, params, id);
    if (msg.error) {
      throw new McpError("mcp_error", msg.error.message ?? `MCP error ${msg.error.code ?? ""}`.trim());
    }
    return msg.result as T;
  }

  /** Runs the initialize handshake exactly once; a failure resets so the next call retries. */
  function ensureReady(): Promise<void> {
    if (!handshake) {
      handshake = rawRequest("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      }).then(
        async () => {
          // A failed notification is non-fatal: the next request surfaces issues.
          await post("notifications/initialized", undefined, undefined).catch(() => {});
        },
        (err: Error) => {
          handshake = undefined;
          throw err;
        },
      );
    }
    return handshake;
  }

  return {
    async request<T>(method: string, params: unknown): Promise<T> {
      await ensureReady();
      return rawRequest<T>(method, params);
    },
    dispose(): void {
      disposed = true;
      handshake = undefined;
      for (const c of inflight) c.abort();
      inflight.clear();
    },
  };
}
