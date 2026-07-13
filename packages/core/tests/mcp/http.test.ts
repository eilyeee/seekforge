import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMcpClient, McpError } from "../../src/mcp/client.js";

const SESSION_ID = "sess-42";

type RecordedRequest = { method: string; id?: number; headers: IncomingHttpHeaders; params?: unknown };

/**
 * Tiny Streamable HTTP MCP server speaking BOTH response styles:
 * - initialize / tools/list / resources/list → plain JSON bodies
 *   (initialize also sets the mcp-session-id header; every later request
 *   must echo it or gets HTTP 400).
 * - tools/call echo → text/event-stream body: one unrelated notification
 *   event first, then the JSON-RPC response event.
 * - tools/call slow → never answers (timeout testing).
 * - tools/call http500 → HTTP 500.
 */
function startFakeServer(): Promise<{
  url: string;
  requests: RecordedRequest[];
  getOversizedSseDisconnects: () => number;
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  const hanging: ServerResponse[] = [];
  let oversizedSseDisconnects = 0;

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const msg = JSON.parse(body || "{}") as {
        method: string;
        id?: number;
        params?: { name?: string; arguments?: unknown };
      };
      requests.push({
        method: msg.method,
        ...(msg.id !== undefined ? { id: msg.id } : {}),
        headers: req.headers,
        params: msg.params,
      });

      const json = (payload: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(200, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(payload));
      };

      if (msg.method === "initialize") {
        json(
          {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "fake-http-mcp", version: "0.0.1" },
            },
          },
          { "mcp-session-id": SESSION_ID },
        );
        return;
      }
      if (msg.id === undefined) {
        if (msg.method === "notifications/cancelled") {
          // A cancellation notification is fire-and-forget. Deliberately never
          // answer so the originating timeout/cancel test proves it does not
          // wait through a second request timeout.
          hanging.push(res);
          return;
        }
        res.writeHead(202).end(); // notification (notifications/initialized)
        return;
      }
      if (req.headers["mcp-session-id"] !== SESSION_ID) {
        res.writeHead(400, { "content-type": "text/plain" }).end("missing session");
        return;
      }
      if (msg.method === "tools/list") {
        json({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            tools: [
              {
                name: "echo",
                description: "Echoes over SSE.",
                inputSchema: { type: "object", properties: { text: { type: "string" } } },
              },
            ],
          },
        });
        return;
      }
      if (msg.method === "resources/list") {
        json({
          jsonrpc: "2.0",
          id: msg.id,
          result: { resources: [{ uri: "mem://http-notes", name: "Notes" }] },
        });
        return;
      }
      if (msg.method === "tools/call") {
        const name = msg.params?.name;
        if (name === "slow") {
          hanging.push(res); // never answered
          return;
        }
        if (name === "http500") {
          res.writeHead(500, { "content-type": "text/plain" }).end("kaput");
          return;
        }
        if (name === "null-response") {
          json(null);
          return;
        }
        if (name === "wrong-id") {
          json({ jsonrpc: "2.0", id: Number(msg.id) + 1, result: {} });
          return;
        }
        if (name === "oversized-sse") {
          res.on("close", () => oversizedSseDisconnects++);
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${"x".repeat(1_100_000)}`);
          hanging.push(res);
          return;
        }
        // SSE response style: noise event first, then the matching response.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n');
        const response = {
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: `sse-echo:${JSON.stringify(msg.params?.arguments)}` }] },
        };
        res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        res.end();
        return;
      }
      json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}/mcp`,
        requests,
        getOversizedSseDisconnects: () => oversizedSseDisconnects,
        close: () =>
          new Promise<void>((done) => {
            for (const res of hanging) res.destroy();
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

let url: string;
let requests: RecordedRequest[];
let closeServer: () => Promise<void>;
let getOversizedSseDisconnects: () => number;

beforeAll(async () => {
  ({ url, requests, getOversizedSseDisconnects, close: closeServer } = await startFakeServer());
});

afterAll(async () => {
  await closeServer();
});

function makeClient(timeoutMs?: number) {
  return createMcpClient({
    name: "fake-http",
    config: { url, headers: { authorization: "Bearer test-token" } },
    requestTimeoutMs: timeoutMs,
  });
}

describe("mcp client over streamable HTTP", () => {
  it("handshakes, sends the configured headers + accept, and parses a JSON tools/list", async () => {
    requests.length = 0;
    const client = makeClient();
    try {
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["echo"]);

      const methods = requests.map((r) => r.method);
      expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
      for (const r of requests) {
        expect(r.headers["content-type"]).toBe("application/json");
        expect(r.headers["accept"]).toBe("application/json, text/event-stream");
        expect(r.headers["authorization"]).toBe("Bearer test-token");
      }
      // The initialize request has no session yet; the server-assigned id is
      // echoed on everything after — including the initialized notification.
      expect(requests[0]!.headers["mcp-session-id"]).toBeUndefined();
      expect(requests[1]!.headers["mcp-session-id"]).toBe(SESSION_ID);
      expect(requests[2]!.headers["mcp-session-id"]).toBe(SESSION_ID);
    } finally {
      client.dispose();
    }
  });

  it("sends protocol 2025-06-18 and the roots capability in initialize", async () => {
    requests.length = 0;
    const client = makeClient();
    try {
      await client.listTools();
      const init = requests.find((r) => r.method === "initialize");
      expect(init?.params).toMatchObject({
        protocolVersion: "2025-06-18",
        capabilities: { roots: { listChanged: true } },
      });
    } finally {
      client.dispose();
    }
  });

  it("parses a text/event-stream response, skipping unrelated SSE events", async () => {
    const client = makeClient();
    try {
      const text = await client.callTool("echo", { text: "hi" });
      expect(text).toBe('sse-echo:{"text":"hi"}');
    } finally {
      client.dispose();
    }
  });

  it("shares one handshake across concurrent first calls", async () => {
    requests.length = 0;
    const client = makeClient();
    try {
      await Promise.all([client.listTools(), client.listTools()]);
      expect(requests.filter((r) => r.method === "initialize")).toHaveLength(1);
    } finally {
      client.dispose();
    }
  });

  it("lists resources through the same transport", async () => {
    const client = makeClient();
    try {
      expect(await client.listResources()).toEqual([{ uri: "mem://http-notes", name: "Notes" }]);
    } finally {
      client.dispose();
    }
  });

  it("times out a request the server never answers", async () => {
    requests.length = 0;
    const client = makeClient(200);
    try {
      const started = Date.now();
      await expect(client.callTool("slow", {})).rejects.toMatchObject({
        name: "McpError",
        code: "mcp_timeout",
      });
      expect(Date.now() - started).toBeLessThan(5_000);
      const slow = requests.find((request) => request.method === "tools/call");
      await vi.waitFor(() => {
        expect(requests.some((request) => request.method === "notifications/cancelled")).toBe(true);
      });
      const cancellation = requests.find((request) => request.method === "notifications/cancelled");
      expect(cancellation?.method).toBe("notifications/cancelled");
      expect(cancellation?.params).toMatchObject({ requestId: slow?.id, reason: "request timed out" });
    } finally {
      client.dispose();
    }
  });

  it("caps incomplete SSE events and cancels the response reader", async () => {
    const before = getOversizedSseDisconnects();
    const client = makeClient(5_000);
    try {
      await expect(client.callTool("oversized-sse", {})).rejects.toMatchObject({ code: "mcp_parse_error" });
      await vi.waitFor(() => expect(getOversizedSseDisconnects()).toBeGreaterThan(before));
    } finally {
      client.dispose();
    }
  });

  it("cancels a pending request and sends notifications/cancelled", async () => {
    requests.length = 0;
    const client = makeClient(5_000);
    const controller = new AbortController();
    try {
      const started = Date.now();
      const pending = client.callTool("slow", {}, controller.signal);
      setTimeout(() => controller.abort(), 25);
      await expect(pending).rejects.toMatchObject({
        name: "McpError",
        code: "mcp_cancelled",
      });
      expect(Date.now() - started).toBeLessThan(1_000);
      await vi.waitFor(() => {
        expect(requests.some((r) => r.method === "notifications/cancelled")).toBe(true);
      });
    } finally {
      client.dispose();
    }
  });

  it("surfaces non-2xx answers as mcp_http_error", async () => {
    const client = makeClient();
    try {
      await expect(client.callTool("http500", {})).rejects.toMatchObject({
        name: "McpError",
        code: "mcp_http_error",
      });
    } finally {
      client.dispose();
    }
  });

  it("propagates JSON-RPC errors as mcp_error", async () => {
    const client = makeClient();
    try {
      await expect(client.readResource("mem://nope")).rejects.toMatchObject({
        name: "McpError",
        code: "mcp_error",
      });
    } finally {
      client.dispose();
    }
  });

  it.each(["null-response", "wrong-id"])("rejects a malformed JSON-RPC response: %s", async (name) => {
    const client = makeClient();
    try {
      await expect(client.callTool(name, {})).rejects.toMatchObject({ code: "mcp_parse_error" });
    } finally {
      client.dispose();
    }
  });

  it("surfaces an unreachable server as mcp_http_error", async () => {
    const client = createMcpClient({
      name: "unreachable",
      config: { url: "http://127.0.0.1:1/mcp" },
    });
    try {
      await expect(client.listTools()).rejects.toMatchObject({ code: "mcp_http_error" });
    } finally {
      client.dispose();
    }
  });

  it("refuses calls after dispose", async () => {
    const client = makeClient();
    client.dispose();
    await expect(client.listTools()).rejects.toMatchObject({ code: "disposed" });
  });

  it("rejects a config with neither command nor url (stdio path)", async () => {
    const client = createMcpClient({ name: "empty", config: {} });
    try {
      await expect(client.listTools()).rejects.toMatchObject({ code: "mcp_config" });
    } finally {
      client.dispose();
    }
  });
});
