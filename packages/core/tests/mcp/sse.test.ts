import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpClient } from "../../src/mcp/client.js";

type Legacy = {
  url: string;
  posts: Array<{ path: string; body: Record<string, unknown>; authorization?: string }>;
  streams: () => number;
  closeStreams: () => void;
  close: () => Promise<void>;
};

type Options = {
  /** What the `endpoint` event announces. */
  endpoint?: (port: number) => string;
  /** Called for each request after initialize; return false to leave it unanswered. */
  onRequest?: (message: Record<string, unknown>, send: (payload: unknown) => void) => boolean | undefined;
  requireAuth?: string;
};

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** A 2024-11-05 HTTP+SSE server: GET /sse streams, POST /messages?sessionId=… accepts. */
async function legacyServer(options: Options = {}): Promise<Legacy> {
  const posts: Legacy["posts"] = [];
  const streams = new Set<ServerResponse>();
  let opened = 0;
  const send = (payload: unknown): void => {
    for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (options.requireAuth && req.headers.authorization !== options.requireAuth) {
      res.writeHead(401).end();
      return;
    }
    const port = (server.address() as AddressInfo).port;
    if (req.method === "GET" && req.url === "/sse") {
      opened++;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      streams.add(res);
      res.on("close", () => streams.delete(res));
      const endpoint = options.endpoint?.(port) ?? "/messages?sessionId=abc";
      res.write(`: comment line\n\nevent: endpoint\ndata: ${endpoint}\n\n`);
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/messages")) {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        posts.push({
          path: req.url!,
          body,
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        });
        res.writeHead(202).end("Accepted");
        if (body.method === "initialize") {
          send({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
          return;
        }
        if (body.id === undefined || body.method === undefined) return;
        if (options.onRequest?.(body, send) === false) return;
        if (body.method === "tools/list") {
          send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
          send({ jsonrpc: "2.0", id: "srv-roots", method: "roots/list" });
          send({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "legacy_tool" }] } });
          return;
        }
        send({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `nope: ${String(body.method)}` } });
      });
      return;
    }
    res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/sse`,
    posts,
    streams: () => opened,
    closeStreams: () => {
      for (const stream of streams) stream.end();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("legacy HTTP+SSE transport", () => {
  it("posts to the announced endpoint and reads responses, notifications and requests from the stream", async () => {
    const server = await legacyServer();
    const notifications: string[] = [];
    const client = createMcpClient({
      name: "legacy",
      config: { type: "sse", url: server.url, headers: { authorization: "Bearer static" } },
      trust: "user",
      workspaceRoots: ["/tmp/ws"],
      onNotification: (notification) => notifications.push(notification.method),
    });
    try {
      expect(await client.listTools()).toEqual([{ name: "legacy_tool" }]);
      expect(notifications).toEqual(["notifications/tools/list_changed"]);
      await vi.waitFor(() => {
        expect(server.posts.find((post) => post.body.id === "srv-roots")?.body).toEqual({
          jsonrpc: "2.0",
          id: "srv-roots",
          result: { roots: [{ uri: "file:///tmp/ws", name: "workspace" }] },
        });
      });
      const methods = server.posts.map((post) => post.body.method);
      expect(methods.slice(0, 3)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
      expect(server.posts.every((post) => post.path === "/messages?sessionId=abc")).toBe(true);
      expect(server.posts.every((post) => post.authorization === "Bearer static")).toBe(true);
      expect(server.streams()).toBe(1);
    } finally {
      client.dispose();
    }
  });

  it("surfaces JSON-RPC errors and reuses one stream for later requests", async () => {
    const server = await legacyServer();
    const client = createMcpClient({ name: "legacy", config: { type: "sse", url: server.url }, trust: "user" });
    try {
      await client.listTools();
      await expect(client.listPrompts()).rejects.toMatchObject({ code: "mcp_error" });
      expect(server.streams()).toBe(1);
    } finally {
      client.dispose();
    }
  });

  it("refuses an endpoint on another origin", async () => {
    const server = await legacyServer({ endpoint: () => "http://evil.example/messages" });
    const client = createMcpClient({ name: "legacy", config: { type: "sse", url: server.url }, trust: "user" });
    try {
      await expect(client.listTools()).rejects.toThrow(/another origin/);
      expect(server.posts).toEqual([]);
    } finally {
      client.dispose();
    }
  });

  it("rejects what is in flight when the stream closes, and reconnects on the next request", async () => {
    let hold = true;
    const server = await legacyServer({
      onRequest: (message, send) => {
        if (message.method !== "tools/list") return;
        if (hold) return false;
        send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
        return false;
      },
    });
    const client = createMcpClient({ name: "legacy", config: { type: "sse", url: server.url }, trust: "user" });
    try {
      const pending = client.listTools();
      await vi.waitFor(() => expect(server.posts.some((post) => post.body.method === "tools/list")).toBe(true));
      server.closeStreams();
      await expect(pending).rejects.toMatchObject({ code: "mcp_http_error" });
      hold = false;
      expect(await client.listTools()).toEqual([]);
      expect(server.streams()).toBe(2);
    } finally {
      client.dispose();
    }
  });

  it("cancels a request on abort and tells the server", async () => {
    const server = await legacyServer({
      onRequest: (message) => (message.method === "tools/list" ? false : undefined),
    });
    const client = createMcpClient({ name: "legacy", config: { type: "sse", url: server.url }, trust: "user" });
    const controller = new AbortController();
    try {
      const pending = client.listTools(controller.signal);
      await vi.waitFor(() => expect(server.posts.some((post) => post.body.method === "tools/list")).toBe(true));
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "mcp_cancelled" });
      await vi.waitFor(() =>
        expect(server.posts.some((post) => post.body.method === "notifications/cancelled")).toBe(true),
      );
    } finally {
      client.dispose();
    }
  });

  it("dispose rejects in-flight requests", async () => {
    const server = await legacyServer({ onRequest: () => false });
    const client = createMcpClient({ name: "legacy", config: { type: "sse", url: server.url }, trust: "user" });
    const pending = client.listTools();
    await vi.waitFor(() => expect(server.posts.some((post) => post.body.method === "tools/list")).toBe(true));
    client.dispose();
    await expect(pending).rejects.toMatchObject({ code: "disposed" });
  });

  it("does not open a stream the server refuses", async () => {
    const server = await legacyServer({ requireAuth: "Bearer right" });
    const client = createMcpClient({
      name: "legacy",
      config: { type: "sse", url: server.url, headers: { authorization: "Bearer wrong" } },
      trust: "user",
    });
    try {
      await expect(client.listTools()).rejects.toThrow(/HTTP 401/);
    } finally {
      client.dispose();
    }
  });
});
