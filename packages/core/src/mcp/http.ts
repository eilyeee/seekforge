import type { McpClientOptions } from "./client.js";
import { McpError } from "./errors.js";
import { abortablePromise, onAbortOnce } from "../util/abort.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_SSE_EVENT_CHARS = 1_048_576;
const MAX_JSON_RESPONSE_BYTES = 1_048_576;
// Latest stable MCP spec revision; servers version-fallback to their own.
const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "seekforge", version: "0.3.0" };
// This request-scoped HTTP implementation does not yet accept server requests.
// Do not advertise roots here: a conforming server may otherwise issue
// roots/list and wait forever for a response. Stdio supports roots fully.
const CLIENT_CAPABILITIES = {} as const;

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

function isJsonRpcResponse(value: unknown, id: number): value is JsonRpcResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { id?: unknown }).id === id &&
    ("result" in value || "error" in value)
  );
}

/** Read a JSON response without buffering an unbounded server-controlled body. */
export async function readLimitedResponseText(response: Response, maxBytes = MAX_JSON_RESPONSE_BYTES): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new McpError("mcp_parse_error", `HTTP response exceeded ${maxBytes} bytes`);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      total += value.byteLength;
      if (total > maxBytes) {
        throw new McpError("mcp_parse_error", `HTTP response exceeded ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

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
        if (sep > MAX_SSE_EVENT_CHARS) {
          throw new McpError("mcp_parse_error", `SSE event exceeded ${MAX_SSE_EVENT_CHARS} characters`);
        }
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
        if (isJsonRpcResponse(msg, id)) {
          return msg;
        }
      }
      if (buffer.length > MAX_SSE_EVENT_CHARS) {
        throw new McpError("mcp_parse_error", `SSE event exceeded ${MAX_SSE_EVENT_CHARS} characters`);
      }
      if (done) {
        // Some servers/proxies flush the final `data:` event and close the
        // connection without the trailing blank line that delimits events —
        // parse whatever remains in the buffer as a last event before giving up.
        const data = buffer
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) {
          try {
            const msg = JSON.parse(data) as JsonRpcResponse;
            if (isJsonRpcResponse(msg, id)) {
              return msg;
            }
          } catch {
            // fall through to the parse error below
          }
        }
        throw new McpError("mcp_parse_error", `SSE stream ended without a response for request ${id}`);
      }
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
 * Static `headers` cover bearer-token servers — and each header value may interpolate
 * `${ENV_VAR}` so secrets live in the environment, not in committed config
 * (e.g. `"Authorization": "Bearer ${GITHUB_MCP_TOKEN}"`). Optional OAuth
 * refresh-token config renews an expired bearer token after HTTP 401. Initial
 * interactive authorization remains frontend-owned. Server-initiated requests and standalone
 * GET streams are also not supported (matching the stdio client's v1 surface).
 */

/** Expands `${VAR}` in a header value from process.env (missing → empty). */
function expandEnvRefs(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "");
}
export function createMcpHttpTransport(options: McpClientOptions): {
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
  dispose(): void;
} {
  const url = options.config.url;
  if (!url) throw new McpError("mcp_config", `MCP server "${options.name}" has no url`);
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  let sessionId: string | undefined;
  let negotiatedVersion: string | undefined;
  let handshake: Promise<void> | undefined;
  let nextId = 1;
  let disposed = false;
  let oauthAccessToken: string | undefined;
  let oauthRefresh: Promise<string> | undefined;
  const inflight = new Set<AbortController>();

  function headers(): Record<string, string> {
    const configured: Record<string, string> = {};
    for (const [k, v] of Object.entries(options.config.headers ?? {})) {
      configured[k] = expandEnvRefs(v);
    }
    if (oauthAccessToken !== undefined) {
      for (const key of Object.keys(configured)) {
        if (key.toLowerCase() === "authorization") delete configured[key];
      }
    }
    return {
      ...configured,
      ...(oauthAccessToken !== undefined ? { authorization: `Bearer ${oauthAccessToken}` } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(negotiatedVersion !== undefined ? { "mcp-protocol-version": negotiatedVersion } : {}),
      ...(sessionId !== undefined ? { "mcp-session-id": sessionId } : {}),
    };
  }

  async function refreshAccessToken(signal: AbortSignal): Promise<string> {
    if (oauthRefresh) return oauthRefresh;
    const oauth = options.config.oauth;
    if (!oauth) throw new McpError("mcp_auth_error", `MCP server "${options.name}" requires authentication`);
    oauthRefresh = (async () => {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: expandEnvRefs(oauth.refreshToken),
        client_id: expandEnvRefs(oauth.clientId),
        ...(oauth.clientSecret !== undefined ? { client_secret: expandEnvRefs(oauth.clientSecret) } : {}),
        ...(oauth.scope !== undefined ? { scope: expandEnvRefs(oauth.scope) } : {}),
      });
      let response: Response;
      try {
        response = await fetch(expandEnvRefs(oauth.tokenEndpoint), {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body,
          signal,
        });
      } catch (error) {
        throw new McpError(
          "mcp_auth_error",
          `MCP OAuth refresh failed for "${options.name}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new McpError(
          "mcp_auth_error",
          `MCP OAuth refresh failed for "${options.name}" with HTTP ${response.status}`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readLimitedResponseText(response)) as unknown;
      } catch {
        throw new McpError("mcp_auth_error", `MCP OAuth refresh for "${options.name}" returned invalid JSON`);
      }
      const token =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)["access_token"]
          : undefined;
      if (typeof token !== "string" || token.length === 0) {
        throw new McpError("mcp_auth_error", `MCP OAuth refresh for "${options.name}" omitted access_token`);
      }
      oauthAccessToken = token;
      return token;
    })().finally(() => {
      oauthRefresh = undefined;
    });
    return oauthRefresh;
  }

  /** POSTs one JSON-RPC message; `id === undefined` marks a notification (response body ignored). */
  async function post(
    method: string,
    params: unknown,
    id: number | undefined,
    signal?: AbortSignal,
  ): Promise<JsonRpcResponse> {
    if (disposed) throw new McpError("disposed", `MCP client "${options.name}" is disposed`);
    if (signal?.aborted) throw new McpError("mcp_cancelled", `MCP ${method} request was cancelled`);
    const controller = new AbortController();
    const offAbort = onAbortOnce(signal, () => controller.abort());
    inflight.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        const send = (): Promise<Response> =>
          fetch(url!, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, params }),
            signal: controller.signal,
          });
        res = await send();
        if (res.status === 401 && options.config.oauth) {
          await res.body?.cancel().catch(() => {});
          await refreshAccessToken(controller.signal);
          res = await send();
        }
      } catch (err) {
        if (controller.signal.aborted) {
          throw disposed
            ? new McpError("disposed", `MCP client "${options.name}" disposed`)
            : signal?.aborted
              ? new McpError("mcp_cancelled", `MCP ${method} request was cancelled`)
              : new McpError(
                  "mcp_timeout",
                  `MCP server "${options.name}" did not answer ${method} within ${timeoutMs}ms`,
                );
        }
        throw new McpError(
          "mcp_http_error",
          `MCP server "${options.name}" unreachable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const newSession = res.headers.get("mcp-session-id");
      if (newSession) sessionId = newSession;
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        // 404 on a request carrying our session id means the server expired or
        // forgot it (e.g. it restarted mid-run). Drop the stale session,
        // handshake, and negotiated protocol version so the next call
        // re-initializes cleanly — a restarted server may speak a different
        // version and would reject the stale mcp-protocol-version header.
        if (res.status === 404 && sessionId) {
          sessionId = undefined;
          handshake = undefined;
          negotiatedVersion = undefined;
        }
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
        const text = await readLimitedResponseText(res);
        const parsed = JSON.parse(text) as unknown;
        if (!isJsonRpcResponse(parsed, id)) {
          throw new McpError("mcp_parse_error", `MCP server "${options.name}" sent a mismatched ${method} response`);
        }
        return parsed;
      } catch (err) {
        if (err instanceof McpError) throw err;
        if (controller.signal.aborted && signal?.aborted) {
          throw new McpError("mcp_cancelled", `MCP ${method} request was cancelled`);
        }
        if (controller.signal.aborted && !disposed) {
          throw new McpError(
            "mcp_timeout",
            `MCP server "${options.name}" did not answer ${method} within ${timeoutMs}ms`,
          );
        }
        throw new McpError(
          "mcp_parse_error",
          `MCP server "${options.name}" sent an unparseable ${method} response: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      clearTimeout(timer);
      offAbort();
      inflight.delete(controller);
    }
  }

  async function rawRequest<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    const id = nextId++;
    let msg: JsonRpcResponse;
    try {
      msg = await post(method, params, id, signal);
    } catch (err) {
      if (
        method !== "initialize" &&
        err instanceof McpError &&
        (err.code === "mcp_cancelled" || err.code === "mcp_timeout")
      ) {
        // Start the notification before rejecting, but do not wait for its
        // response: a server that ignored the original request may also never
        // answer this notification, which must not add a second timeout window.
        void post(
          "notifications/cancelled",
          { requestId: id, reason: err.code === "mcp_timeout" ? "request timed out" : "caller aborted" },
          undefined,
        ).catch(() => {});
      }
      throw err;
    }
    if (msg.error) {
      throw new McpError("mcp_error", msg.error.message ?? `MCP error ${msg.error.code ?? ""}`.trim());
    }
    return msg.result as T;
  }

  /** Runs the initialize handshake exactly once; a failure resets so the next call retries. */
  function ensureReady(): Promise<void> {
    if (!handshake) {
      handshake = rawRequest<{ protocolVersion?: unknown }>("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: CLIENT_CAPABILITIES,
        clientInfo: CLIENT_INFO,
      })
        .then(async (result) => {
          if (typeof result?.protocolVersion !== "string" || result.protocolVersion.length === 0) {
            throw new McpError("mcp_parse_error", "MCP initialize result omitted protocolVersion");
          }
          negotiatedVersion = result.protocolVersion;
          // A failed notification is non-fatal: the next request surfaces issues.
          await post("notifications/initialized", undefined, undefined).catch(() => {});
        })
        .catch((err: unknown) => {
          handshake = undefined;
          sessionId = undefined;
          negotiatedVersion = undefined;
          throw err;
        });
    }
    return handshake;
  }

  async function waitUntilReady(method: string, signal?: AbortSignal): Promise<void> {
    await abortablePromise(
      ensureReady(),
      signal,
      () => new McpError("mcp_cancelled", `MCP ${method} request was cancelled`),
    );
  }

  return {
    async request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) throw new McpError("mcp_cancelled", `MCP ${method} request was cancelled`);
      await waitUntilReady(method, signal);
      return rawRequest<T>(method, params, signal);
    },
    dispose(): void {
      const deleteHeaders = sessionId !== undefined ? headers() : undefined;
      disposed = true;
      handshake = undefined;
      sessionId = undefined;
      negotiatedVersion = undefined;
      for (const c of inflight) c.abort();
      inflight.clear();
      if (deleteHeaders) {
        void fetch(url, { method: "DELETE", headers: deleteHeaders })
          .then((response) => response.body?.cancel())
          .catch(() => {});
      }
    },
  };
}
