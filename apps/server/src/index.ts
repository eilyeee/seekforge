/**
 * @seekforge/server — Local Agent Server (SERVER-API.md).
 *
 * Embeddable: `seekforge serve` and (later) the Tauri shell call startServer.
 * Binds 127.0.0.1 only; every request must present the bearer token
 * (Authorization header, or ?token= for WS upgrade / initial page load).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";
import { createDefaultAgent, type CreateAgentFn } from "./agent.js";
import { handleApi, sendApiError } from "./rest.js";
import { resolveStaticRoot, serveStatic } from "./static.js";
import { handleConnection } from "./ws.js";

export type { AgentHandle, CreateAgentFn, CreateAgentOptions } from "./agent.js";
export type { ServerConfig } from "./config.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export type StartServerOptions = {
  /** Absolute or relative path of the single workspace this server drives. */
  workspace: string;
  /** TCP port (127.0.0.1). 0 picks an ephemeral port. Default: 7373. */
  port?: number;
  /** Pre-set auth token (embedding/tests); random when omitted. */
  token?: string;
  /** Test/embedding override for the agent assembly. Default: real DeepSeek assembly. */
  createAgent?: CreateAgentFn;
  /** Test/embedding override for the static UI root. Default: apps/desktop/dist. */
  staticDir?: string;
};

export type RunningServer = {
  port: number;
  token: string;
  close(): Promise<void>;
};

export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const workspace = resolve(opts.workspace);
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const createAgent = opts.createAgent ?? createDefaultAgent;
  const staticRoot = resolveStaticRoot(opts.staticDir);

  let port = 0; // the real port, known after listen()

  const server = createServer((req, res) => {
    // Deliberately no Access-Control-Allow-Origin header (same-origin UI only).
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      // The token gates capability (API/WS). Static assets are public: the
      // UI bundle is not a secret, and index.html's subresource requests
      // cannot carry the token anyway.
      if (!isAuthorized(req, token)) {
        return sendApiError(res, 401, "unauthorized", "missing or invalid token");
      }
      void handleApi(req, res, url, { workspace, version });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendApiError(res, 405, "method_not_allowed", `${req.method} not allowed for ${url.pathname}`);
    }
    serveStatic(res, { root: staticRoot, pathname: url.pathname, port, workspace });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!isAuthorized(req, token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, { workspace, createAgent }));
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(opts.port ?? 7373, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("could not determine the listen port");
  }
  port = address.port;

  const close = (): Promise<void> =>
    new Promise<void>((resolveClose, rejectClose) => {
      // Terminating sockets triggers their close handlers -> running sessions abort.
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.close((err) => (err ? rejectClose(err) : resolveClose()));
      server.closeAllConnections();
    });

  return { port, token, close };
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const auth = req.headers.authorization;
  let presented: string | null = null;
  if (auth?.startsWith("Bearer ")) {
    presented = auth.slice("Bearer ".length);
  } else {
    try {
      presented = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("token");
    } catch {
      return false;
    }
  }
  if (!presented) return false;
  // Hash both sides so timingSafeEqual always compares equal-length buffers.
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}
