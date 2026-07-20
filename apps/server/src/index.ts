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
import { WebSocketServer } from "ws";
import {
  createDefaultAgent,
  resumeDefaultLoop,
  runDefaultLoop,
  type CreateAgentFn,
  type ResumeLoopFn,
  type RunLoopFn,
} from "./agent.js";
import { handleApi, sendApiError } from "./rest.js";
import { resolveStaticRoot, serveStatic } from "./static.js";
import { createWorkspaceRegistry } from "./workspaces.js";
import { WorktreeManager } from "./worktrees.js";
import { handleConnection } from "./ws.js";
import type { TriggerRunHandle } from "./trigger-run.js";
import { ServerCoordinator } from "./coordinator.js";
import { RunManager } from "./run-ledger.js";
import { createStructuredLogger, type StructuredLogger } from "./logger.js";

export type { AgentHandle, CreateAgentFn, CreateAgentOptions, ResumeLoopFn, RunLoopFn, RunOverrides } from "./agent.js";
export type { ServerConfig } from "./config.js";
export type { Workspace } from "./workspaces.js";
export type { MergeResult, WorktreeStatus } from "./worktrees.js";
export { readRunEvents, readRunLedger, RunManager } from "./run-ledger.js";
export type { RunEvent, RunRecord, RunSource, RunStatus } from "./run-ledger.js";
export { createStructuredLogger } from "./logger.js";
export type { StructuredLogger } from "./logger.js";

// Normally reads @seekforge/server's package version. In a bun --compile
// binary (the Tauri sidecar) the package.json isn't on the virtual FS, so
// fall back to a constant — version is only surfaced via the /api endpoint.
const version = ((): string => {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

export type StartServerOptions = {
  /**
   * Workspaces this server drives. Provide either `workspaces` (one or more,
   * the first is the default) or the single `workspace` (back-compat). At least
   * one must be given.
   */
  workspaces?: string[];
  /** Single-workspace shorthand (back-compat). Equivalent to `workspaces: [workspace]`. */
  workspace?: string;
  /** TCP port (127.0.0.1). 0 picks an ephemeral port. Default: 7373. */
  port?: number;
  /** Pre-set auth token (embedding/tests); random when omitted. */
  token?: string;
  /** Test/embedding override for the agent assembly. Default: real DeepSeek assembly. */
  createAgent?: CreateAgentFn;
  /** Test/embedding override for the auto-loop runner. Default: real DeepSeek loop. */
  runLoop?: RunLoopFn;
  /** Test/embedding override for persisted auto-loop resume. */
  resumeLoop?: ResumeLoopFn;
  /** Test/embedding override for the static UI root. Default: apps/desktop/dist. */
  staticDir?: string;
  /** Structured JSON logger override. Defaults to stderr. */
  logger?: StructuredLogger;
};

export type RunningServer = {
  port: number;
  token: string;
  close(): Promise<void>;
};

/** Bound authenticated WS input before JSON parsing can amplify memory use. */
export const MAX_WS_PAYLOAD_BYTES = 1_000_000;

export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const paths = opts.workspaces ?? (opts.workspace !== undefined ? [opts.workspace] : []);
  if (paths.length === 0) {
    throw new Error("startServer requires `workspaces` or `workspace`");
  }
  const registry = createWorkspaceRegistry(paths);
  const coordinator = new ServerCoordinator();
  const worktrees = new WorktreeManager(registry, coordinator);
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const createAgent = opts.createAgent ?? createDefaultAgent;
  const runLoop = opts.runLoop ?? runDefaultLoop;
  const resumeLoop = opts.resumeLoop ?? resumeDefaultLoop;
  const staticRoot = resolveStaticRoot(opts.staticDir);
  const triggerRuns = new Set<TriggerRunHandle>();
  const runManager = new RunManager();
  const logger = opts.logger ?? createStructuredLogger();

  let port = 0; // the real port, known after listen()

  const server = createServer((req, res) => {
    // Deliberately no Access-Control-Allow-Origin header (same-origin UI only).
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const requestStartedAt = Date.now();
    const requestId = randomBytes(8).toString("hex");
    res.once("finish", () => {
      const durationMs = Date.now() - requestStartedAt;
      runManager.recordHttp(res.statusCode, durationMs);
      logger.log(res.statusCode >= 500 ? "error" : "info", "http.request", {
        requestId,
        method: req.method ?? "GET",
        path: url.pathname,
        status: res.statusCode,
        durationMs,
      });
    });
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      // The token gates capability (API/WS). Static assets are public: the
      // UI bundle is not a secret, and index.html's subresource requests
      // cannot carry the token anyway.
      if (!isAuthorized(req, token) && !isGitHubTriggerRequest(req, url)) {
        return sendApiError(res, 401, "unauthorized", "missing or invalid token");
      }
      const operation = handleApi(req, res, url, {
        registry,
        worktrees,
        coordinator,
        version,
        createAgent,
        runLoop,
        triggerRuns,
        runManager,
        logger,
        requestId,
      }).catch((e: unknown) => {
        // Defense-in-depth: handleApi answers its own errors, but never leave a
        // request hanging on an unexpected rejection.
        if (!res.headersSent) {
          sendApiError(res, 500, "internal_error", e instanceof Error ? e.message : String(e));
        }
      });
      void coordinator.track(operation);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendApiError(res, 405, "method_not_allowed", `${req.method} not allowed for ${url.pathname}`);
    }
    serveStatic(res, { root: staticRoot, pathname: url.pathname, port, workspace: registry.default.path });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });
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
    wss.handleUpgrade(req, socket, head, (ws) =>
      handleConnection(ws, {
        registry,
        createAgent,
        runLoop,
        resumeLoop,
        runManager,
        trackOperation: (operation) => coordinator.track(operation),
        withRepository: (workspace, operation) => coordinator.withRepository(workspace, operation),
        withAgentMutation: (workspace, signal, operation) =>
          coordinator.withAgentMutation(workspace, signal, operation),
      }),
    );
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
  logger.log("info", "server.ready", { port, workspaces: registry.summary.length });

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      for (const run of triggerRuns) run.abort();
      const closing = new Promise<void>((resolveClose, rejectClose) => {
        // Terminating sockets triggers their close handlers, which abort active
        // runs. Those run promises are tracked by the coordinator and drained.
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
        server.closeAllConnections();
      });
      await Promise.allSettled([...triggerRuns].map((run) => run.completion));
      await coordinator.drain();
      await closing;
      logger.log("info", "server.closed", { port });
    })();
    return closePromise;
  };

  return { port, token, close };
}

/** Signed GitHub trigger calls authenticate in the trigger route using its per-trigger secret. */
function isGitHubTriggerRequest(req: IncomingMessage, url: URL): boolean {
  return (
    req.method === "POST" &&
    /^\/api\/triggers\/[^/]+$/.test(url.pathname) &&
    typeof req.headers["x-hub-signature-256"] === "string" &&
    typeof req.headers["x-github-delivery"] === "string"
  );
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
