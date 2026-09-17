import type { McpClientOptions } from "./client.js";
import { McpError } from "./errors.js";
import { consumeSseEvents, createMcpHttpAuth } from "./http.js";
import { clientCapabilities, createServerRequestResponder } from "./server-requests.js";
import { abortablePromise, onAbortOnce } from "../util/abort.js";
import { isRecord } from "../util/guards.js";
import { SEEKFORGE_VERSION } from "../version.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Same ceiling the other transports put on a request that keeps reporting progress. */
const MAX_REQUEST_TOTAL_MS = 10 * 60_000;
/** How long the server has to announce its message endpoint after the stream opens. */
const ENDPOINT_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "seekforge", version: SEEKFORGE_VERSION };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
  extend: () => void;
};

type Connection = {
  controller: AbortController;
  endpoint: Promise<URL>;
  ready?: Promise<void>;
};

type JsonRpcMessage = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

/**
 * The legacy HTTP+SSE transport (MCP 2024-11-05), selected by `type: "sse"`.
 *
 * The client opens one long-lived `GET <url>` event stream. The server's first
 * event, `endpoint`, names the URL every client message is POSTed to; every
 * server message — responses, notifications, requests — arrives on the stream
 * as a `message` event. A POST's own response body carries nothing.
 *
 * The announced endpoint must share the stream's origin. The POSTs carry the
 * same headers as the stream, bearer tokens included, so an endpoint on another
 * origin would hand those credentials to whoever the server named.
 *
 * A closed or failed stream rejects everything in flight; the next request
 * opens a new stream and handshakes again.
 */
export function createMcpSseTransport(options: McpClientOptions): {
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
  dispose(): void;
} {
  const url = options.config.url;
  if (!url) throw new McpError("mcp_config", `MCP server "${options.name}" has type "sse" but no url`);
  const streamUrl = new URL(url);
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxTotal = options.maxRequestTotalMs ?? MAX_REQUEST_TOTAL_MS;
  const auth = createMcpHttpAuth(options.name, options.config, url);
  const respondToServer = createServerRequestResponder({
    name: options.name,
    ...(options.workspaceRoots !== undefined ? { workspaceRoots: options.workspaceRoots } : {}),
    ...(options.serverRequestHandlers !== undefined ? { handlers: options.serverRequestHandlers } : {}),
  });
  const pending = new Map<number, Pending>();
  const inflight = new Set<AbortController>();
  let connection: Connection | undefined;
  let nextId = 1;
  let disposed = false;

  const disposedError = (): McpError => new McpError("disposed", `MCP client "${options.name}" disposed`);
  const cancelledError = (method: string): McpError =>
    new McpError("mcp_cancelled", `MCP ${method} request was cancelled`);

  function failPending(error: McpError): void {
    const stale = [...pending.values()];
    pending.clear();
    for (const entry of stale) {
      clearTimeout(entry.timer);
      entry.cleanup();
      entry.reject(error);
    }
  }

  /** POSTs one JSON-RPC message to the announced endpoint; the body of the reply is ignored. */
  async function post(endpoint: URL, payload: unknown, what: string, signal?: AbortSignal): Promise<void> {
    if (disposed) throw disposedError();
    const controller = new AbortController();
    const offAbort = onAbortOnce(signal, () => controller.abort());
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    inflight.add(controller);
    try {
      const send = (): Promise<Response> =>
        fetch(endpoint, {
          method: "POST",
          headers: { ...auth.headers(), "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      let response = await send();
      if (response.status === 401 && auth.canRenew()) {
        await response.body?.cancel().catch(() => {});
        await auth.refresh(controller.signal);
        response = await send();
      }
      await response.body?.cancel().catch(() => {});
      if (!response.ok) {
        throw new McpError(
          "mcp_http_error",
          `MCP server "${options.name}" rejected ${what} with HTTP ${response.status}`,
        );
      }
    } catch (error) {
      if (error instanceof McpError) throw error;
      if (controller.signal.aborted) {
        if (disposed) throw disposedError();
        if (signal?.aborted) throw cancelledError(what);
        throw new McpError("mcp_timeout", `MCP server "${options.name}" did not accept ${what} within ${timeoutMs}ms`);
      }
      throw new McpError(
        "mcp_http_error",
        `MCP server "${options.name}" unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
      offAbort();
      inflight.delete(controller);
    }
  }

  function handleMessage(message: JsonRpcMessage, conn: Connection): void {
    const id = message.id;
    if (("result" in message || "error" in message) && typeof id === "number") {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.cleanup();
      if (message.error) {
        entry.reject(
          new McpError("mcp_error", message.error.message ?? `MCP error ${message.error.code ?? ""}`.trim()),
        );
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    const method = message.method;
    if (id === undefined || id === null) {
      if (method === "notifications/progress") {
        const token = isRecord(message.params) ? message.params["progressToken"] : undefined;
        if (typeof token === "number") pending.get(token)?.extend();
      }
      try {
        options.onNotification?.({ method, ...(message.params !== undefined ? { params: message.params } : {}) });
      } catch {
        // Consumer callbacks are advisory and must not break the stream.
      }
      return;
    }
    if (typeof id !== "string" && typeof id !== "number") return;
    void respondToServer(id, method, message.params, conn.controller.signal).then(async (reply) => {
      if (connection !== conn) return;
      try {
        await post(await conn.endpoint, reply, `${method} response`, conn.controller.signal);
      } catch {
        // The server sees a missing answer as its own timeout.
      }
    });
  }

  function open(): Connection {
    if (connection) return connection;
    if (disposed) throw disposedError();
    const controller = new AbortController();
    let resolveEndpoint!: (endpoint: URL) => void;
    let rejectEndpoint!: (error: Error) => void;
    const endpoint = new Promise<URL>((resolve, reject) => {
      resolveEndpoint = resolve;
      rejectEndpoint = reject;
    });
    // Awaited by every request; a stream that fails before anyone asks must
    // not surface as an unhandled rejection.
    endpoint.catch(() => {});
    const conn: Connection = { controller, endpoint };
    connection = conn;
    const endpointTimer = setTimeout(() => {
      drop(
        new McpError(
          "mcp_timeout",
          `MCP server "${options.name}" announced no endpoint within ${ENDPOINT_TIMEOUT_MS}ms`,
        ),
      );
    }, ENDPOINT_TIMEOUT_MS);
    endpointTimer.unref?.();

    function drop(error: McpError): void {
      clearTimeout(endpointTimer);
      rejectEndpoint(error);
      if (connection !== conn) return;
      connection = undefined;
      controller.abort();
      failPending(error);
    }

    void (async () => {
      try {
        const request = (): Promise<Response> =>
          fetch(streamUrl, {
            method: "GET",
            headers: { ...auth.headers(), accept: "text/event-stream" },
            signal: controller.signal,
          });
        let response = await request();
        if (response.status === 401 && auth.canRenew()) {
          await response.body?.cancel().catch(() => {});
          await auth.refresh(controller.signal);
          response = await request();
        }
        if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
          await response.body?.cancel().catch(() => {});
          throw new McpError(
            "mcp_http_error",
            `MCP server "${options.name}" did not open an event stream (HTTP ${response.status})`,
          );
        }
        let announced = false;
        await consumeSseEvents(response.body, async ({ event, data }) => {
          if (connection !== conn) return true;
          if (event === "endpoint") {
            if (announced) return false;
            let target: URL;
            try {
              target = new URL(data.trim(), streamUrl);
            } catch {
              throw new McpError("mcp_parse_error", `MCP server "${options.name}" announced an invalid endpoint`);
            }
            if (target.origin !== streamUrl.origin) {
              throw new McpError(
                "mcp_http_error",
                `MCP server "${options.name}" announced an endpoint on another origin (${target.origin})`,
              );
            }
            announced = true;
            clearTimeout(endpointTimer);
            resolveEndpoint(target);
            return false;
          }
          if (event !== "message") return false;
          let message: unknown;
          try {
            message = JSON.parse(data) as unknown;
          } catch {
            return false;
          }
          if (isRecord(message)) handleMessage(message as JsonRpcMessage, conn);
          return false;
        });
        drop(new McpError("mcp_http_error", `MCP server "${options.name}" closed its event stream`));
      } catch (error) {
        if (error instanceof McpError) drop(error);
        else if (disposed) drop(disposedError());
        else if (controller.signal.aborted) drop(new McpError("mcp_http_error", "event stream aborted"));
        else {
          drop(
            new McpError(
              "mcp_http_error",
              `MCP server "${options.name}" unreachable: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      }
    })();
    return conn;
  }

  function rawRequest<T>(conn: Connection, method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(cancelledError(method));
        return;
      }
      let cleanup: () => void = () => {};
      const deadline = Date.now() + maxTotal;
      const notifyCancelled = (reason: string): void => {
        void conn.endpoint
          .then((endpoint) =>
            post(
              endpoint,
              { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason } },
              "notifications/cancelled",
            ),
          )
          .catch(() => {});
      };
      const expire = (why: string): void => {
        if (pending.get(id) !== entry) return;
        pending.delete(id);
        cleanup();
        notifyCancelled("request timed out");
        reject(new McpError("mcp_timeout", `MCP server "${options.name}" did not answer ${method} ${why}`));
      };
      const entry: Pending = {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: setTimeout(() => expire(`within ${timeoutMs}ms`), timeoutMs),
        cleanup: () => cleanup(),
        extend: () => {
          clearTimeout(entry.timer);
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            expire(`within ${maxTotal}ms including progress`);
            return;
          }
          entry.timer = setTimeout(() => expire(`within ${timeoutMs}ms`), Math.min(timeoutMs, remaining));
        },
      };
      pending.set(id, entry);
      cleanup = onAbortOnce(signal, () => {
        if (pending.get(id) !== entry) return;
        pending.delete(id);
        clearTimeout(entry.timer);
        notifyCancelled("caller aborted");
        reject(cancelledError(method));
      });
      if (signal?.aborted) return;
      const withToken = isRecord(params)
        ? { ...params, _meta: { ...(isRecord(params["_meta"]) ? params["_meta"] : {}), progressToken: id } }
        : params;
      void conn.endpoint
        .then((endpoint) => post(endpoint, { jsonrpc: "2.0", id, method, params: withToken }, method, signal))
        .catch((error: unknown) => {
          if (pending.get(id) !== entry) return;
          pending.delete(id);
          clearTimeout(entry.timer);
          cleanup();
          reject(error instanceof Error ? error : new McpError("mcp_http_error", String(error)));
        });
    });
  }

  function ensureReady(conn: Connection): Promise<void> {
    if (!conn.ready) {
      conn.ready = rawRequest<{ protocolVersion?: unknown }>(conn, "initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: clientCapabilities(options.serverRequestHandlers),
        clientInfo: CLIENT_INFO,
      })
        .then(async (result) => {
          if (typeof result?.protocolVersion !== "string" || result.protocolVersion.length === 0) {
            throw new McpError("mcp_parse_error", "MCP initialize result omitted protocolVersion");
          }
          await post(
            await conn.endpoint,
            { jsonrpc: "2.0", method: "notifications/initialized" },
            "notifications/initialized",
          ).catch(() => {});
        })
        .catch((error: unknown) => {
          // A failed handshake leaves nothing half-open: the next call starts a new stream.
          if (connection === conn) {
            connection = undefined;
            conn.controller.abort();
          }
          throw error;
        });
    }
    return conn.ready;
  }

  return {
    async request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
      if (disposed) throw disposedError();
      if (signal?.aborted) throw cancelledError(method);
      const conn = open();
      await abortablePromise(ensureReady(conn), signal, () => cancelledError(method));
      return rawRequest<T>(conn, method, params, signal);
    },
    dispose(): void {
      disposed = true;
      const conn = connection;
      connection = undefined;
      conn?.controller.abort();
      for (const controller of inflight) controller.abort();
      inflight.clear();
      failPending(disposedError());
    },
  };
}
