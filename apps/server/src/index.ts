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
  createLoopRecoveryScheduler,
  createGraphMaintenanceScheduler,
  createMemoryMaintenanceScheduler,
  graphExecutorsWithPlugins,
  loadPluginContributions,
  recordLoopRecoveryFailure,
  recoverInterruptedLoops,
  pruneLoopStates,
  pruneEngineeringGraphStates,
  recoverableEngineeringGraphStates,
  type GraphMaintenanceScheduler,
  type GraphExecutionAdapter,
  type LoopRecoveryScheduler,
  type LoopResult,
} from "@seekforge/core";
import { MAX_WS_PAYLOAD_BYTES } from "@seekforge/shared/protocol-limits";
import {
  createDefaultAgent,
  resumeDefaultLoop,
  runDefaultGraph,
  runDefaultLoop,
  type CreateAgentFn,
  type ResumeLoopFn,
  type RunLoopFn,
  type RunGraphFn,
} from "./agent.js";
import { discardRequestBody } from "./http.js";
import { handleApi, sendApiError } from "./rest.js";
import { resolveStaticRoot, serveStatic } from "./static.js";
import { createWorkspaceRegistry } from "./workspaces.js";
import { WorktreeManager } from "./worktrees.js";
import { handleConnection } from "./ws.js";
import type { TriggerRunHandle } from "./trigger-run.js";
import { ServerCoordinator } from "./coordinator.js";
import { RunManager } from "./run-ledger.js";
import { createStructuredLogger, type StructuredLogger } from "./logger.js";
import { loadConfig } from "./config.js";

export type {
  AgentHandle,
  CreateAgentFn,
  CreateAgentOptions,
  ResumeLoopFn,
  RunGraphFn,
  RunLoopFn,
  RunOverrides,
} from "./agent.js";
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
  /** Test/embedding override for Engineering Graph execution. */
  runGraph?: RunGraphFn;
  /** Host-owned trusted remote Graph executors available directly and through plugin aliases. */
  graphExecutors?: Readonly<Record<string, GraphExecutionAdapter>>;
  /** Test/embedding override for persisted auto-loop resume. */
  resumeLoop?: ResumeLoopFn;
  /** Test/embedding override for the static UI root. Default: apps/desktop/dist. */
  staticDir?: string;
  /** Structured JSON logger override. Defaults to stderr. */
  logger?: StructuredLogger;
  /** Embedding/test override for the first idle-memory check delay. */
  memoryMaintenanceInitialDelayMs?: number;
  /** Embedding/test override for the recurring idle-memory check interval. */
  memoryMaintenanceIntervalMs?: number;
  /** Opt in to resuming interrupted durable Loops while their workspace is idle. */
  loopAutoResume?: boolean;
  /** Embedding/test override for the first idle-Loop recovery delay. */
  loopRecoveryInitialDelayMs?: number;
  /** Embedding/test override for the recurring idle-Loop recovery interval. */
  loopRecoveryIntervalMs?: number;
  /** Maximum interrupted Loops resumed per workspace and idle tick. Default 3. */
  loopRecoveryMaxPerTick?: number;
  /** Prune terminal Loop records during idle maintenance. */
  loopAutoPrune?: boolean;
  /** Maximum age of terminal Loop records. Default 30 days. */
  loopRetentionMaxAgeDays?: number;
  /** Maximum retained eligible terminal Loop records. Default 100. */
  loopRetentionMaxCount?: number;
  /** Resume interrupted durable Graphs while their workspace is idle. */
  graphAutoResume?: boolean;
  /** Prune old terminal Graph records and clean managed resources while idle. */
  graphAutoPrune?: boolean;
  graphMaintenanceInitialDelayMs?: number;
  graphMaintenanceIntervalMs?: number;
  graphRecoveryMaxPerTick?: number;
  graphRetentionMaxAgeDays?: number;
  graphRetentionMaxCount?: number;
};

export type RunningServer = {
  port: number;
  token: string;
  close(): Promise<void>;
};

/** Bound authenticated WS input before JSON parsing can amplify memory use. */
export { MAX_WS_PAYLOAD_BYTES } from "@seekforge/shared/protocol-limits";

export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  if (
    opts.loopRecoveryMaxPerTick !== undefined &&
    (!Number.isSafeInteger(opts.loopRecoveryMaxPerTick) || opts.loopRecoveryMaxPerTick <= 0)
  ) {
    throw new RangeError("loopRecoveryMaxPerTick must be a positive integer");
  }
  if (
    opts.loopRetentionMaxAgeDays !== undefined &&
    (!Number.isFinite(opts.loopRetentionMaxAgeDays) || opts.loopRetentionMaxAgeDays < 0)
  )
    throw new RangeError("loopRetentionMaxAgeDays must be a non-negative finite number");
  if (
    opts.loopRetentionMaxCount !== undefined &&
    (!Number.isSafeInteger(opts.loopRetentionMaxCount) || opts.loopRetentionMaxCount < 0)
  )
    throw new RangeError("loopRetentionMaxCount must be a non-negative integer");
  if (
    opts.graphRecoveryMaxPerTick !== undefined &&
    (!Number.isSafeInteger(opts.graphRecoveryMaxPerTick) ||
      opts.graphRecoveryMaxPerTick < 1 ||
      opts.graphRecoveryMaxPerTick > 100)
  ) {
    throw new RangeError("graphRecoveryMaxPerTick must be 1 to 100");
  }
  if (
    opts.graphRetentionMaxAgeDays !== undefined &&
    (!Number.isSafeInteger(opts.graphRetentionMaxAgeDays) ||
      opts.graphRetentionMaxAgeDays < 0 ||
      opts.graphRetentionMaxAgeDays > 3_650)
  ) {
    throw new RangeError("graphRetentionMaxAgeDays must be 0 to 3650");
  }
  if (
    opts.graphRetentionMaxCount !== undefined &&
    (!Number.isSafeInteger(opts.graphRetentionMaxCount) ||
      opts.graphRetentionMaxCount < 0 ||
      opts.graphRetentionMaxCount > 10_000)
  ) {
    throw new RangeError("graphRetentionMaxCount must be 0 to 10000");
  }
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
  const runGraph = opts.runGraph ?? runDefaultGraph;
  const graphExecutorsFor = (workspace: string): Readonly<Record<string, GraphExecutionAdapter>> =>
    Object.freeze({
      ...graphExecutorsWithPlugins(loadPluginContributions(workspace), opts.graphExecutors ?? {}),
      ...(opts.graphExecutors ?? {}),
    });
  const resumeLoop = opts.resumeLoop ?? resumeDefaultLoop;
  const staticRoot = resolveStaticRoot(opts.staticDir);
  const triggerRuns = new Set<TriggerRunHandle>();
  const graphRuns = new Map<string, string>();
  const runManager = new RunManager((workspace) => {
    const config = loadConfig(workspace);
    return {
      maxTerminalRuns: config.runRetentionMaxCount,
      maxAgeDays: config.runRetentionMaxAgeDays,
    };
  });
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
        runGraph,
        graphExecutors: opts.graphExecutors,
        triggerRuns,
        graphRuns,
        runManager,
        logger,
        requestId,
      })
        .catch((e: unknown) => {
          // Defense-in-depth: handleApi answers its own errors, but never leave a
          // request hanging on an unexpected rejection.
          if (!res.headersSent) {
            sendApiError(res, 500, "internal_error", e instanceof Error ? e.message : String(e));
          }
        })
        .finally(() => discardRequestBody(req));
      void coordinator.track(operation);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendApiError(res, 405, "method_not_allowed", `${req.method} not allowed for ${url.pathname}`);
    }
    serveStatic(res, {
      root: staticRoot,
      pathname: url.pathname,
      port,
      workspace: registry.default.path,
      head: req.method === "HEAD",
    });
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

  const memoryMaintenanceScheduler = createMemoryMaintenanceScheduler({
    targets: () =>
      registry.list.map((workspace) => ({
        workspace: workspace.path,
        getConfig: () => loadConfig(workspace.path).memoryMaintenance,
      })),
    onResults: (results) => {
      for (const result of results) {
        if (result.outcome.status === "completed") {
          logger.log("info", "memory.maintenance.completed", {
            workspace: result.workspace,
            ...result.outcome.state.lastResult,
          });
        } else if (result.outcome.status === "failed") {
          logger.log("error", "memory.maintenance.failed", {
            workspace: result.workspace,
            error: result.outcome.error,
          });
        }
      }
    },
    ...(opts.memoryMaintenanceInitialDelayMs !== undefined
      ? { initialDelayMs: opts.memoryMaintenanceInitialDelayMs }
      : {}),
    ...(opts.memoryMaintenanceIntervalMs !== undefined ? { intervalMs: opts.memoryMaintenanceIntervalMs } : {}),
  });

  let loopRecoveryScheduler: LoopRecoveryScheduler | undefined;
  try {
    loopRecoveryScheduler =
      opts.loopAutoResume || opts.loopAutoPrune
        ? createLoopRecoveryScheduler({
            targets: () =>
              registry.list.map((workspace) => ({
                workspace: workspace.path,
                recover: async (signal): Promise<LoopResult[] | undefined> => {
                  const attempt = await coordinator.tryWithIdleAgentMutation(
                    workspace.path,
                    signal,
                    async (idleGuard, recoverySignal) => {
                      const results: LoopResult[] = [];
                      for (const state of opts.loopAutoResume
                        ? recoverInterruptedLoops(workspace.path, { limit: opts.loopRecoveryMaxPerTick ?? 3 })
                        : []) {
                        recoverySignal.throwIfAborted();
                        try {
                          results.push(
                            await resumeLoop(
                              {
                                workspace: workspace.path,
                                confirm: async () => false,
                                extractMemory: true,
                                signal: recoverySignal,
                              },
                              state.loopId,
                              {
                                workspace: workspace.path,
                                approvalMode: "acceptEdits",
                                abortStatus: "interrupted",
                                signal: recoverySignal,
                                workspaceGuard: idleGuard,
                              },
                            ),
                          );
                        } catch (error) {
                          if (recoverySignal.aborted) {
                            if (signal.aborted) throw error;
                            break;
                          }
                          recordLoopRecoveryFailure(workspace.path, state.loopId, error);
                          logger.log("error", "loop.recovery.failed", {
                            workspace: workspace.path,
                            loopId: state.loopId,
                            error: error instanceof Error ? error.message : String(error),
                          });
                        }
                      }
                      if (opts.loopAutoPrune) {
                        if (recoverySignal.aborted) return results;
                        const pruned = pruneLoopStates(workspace.path, {
                          maxAgeDays: opts.loopRetentionMaxAgeDays ?? 30,
                          maxTerminalCount: opts.loopRetentionMaxCount ?? 100,
                          workspaceGuard: idleGuard,
                        });
                        if (pruned.removed.length > 0 || pruned.skipped.length > 0) {
                          logger.log("info", "loop.prune.completed", {
                            workspace: workspace.path,
                            removed: pruned.removed,
                            skipped: pruned.skipped,
                          });
                        }
                      }
                      return results;
                    },
                  );
                  return attempt.acquired ? attempt.value : undefined;
                },
              })),
            onResults: (results) => {
              for (const result of results) {
                if (result.outcome.status === "completed" && result.outcome.results.length > 0) {
                  logger.log("info", "loop.recovery.completed", {
                    workspace: result.workspace,
                    count: result.outcome.results.length,
                    loops: result.outcome.results.map((loop) => ({ loopId: loop.loopId, status: loop.status })),
                  });
                } else if (result.outcome.status === "failed") {
                  logger.log("error", "loop.recovery.failed", {
                    workspace: result.workspace,
                    error: result.outcome.error,
                  });
                }
              }
            },
            ...(opts.loopRecoveryInitialDelayMs !== undefined
              ? { initialDelayMs: opts.loopRecoveryInitialDelayMs }
              : {}),
            ...(opts.loopRecoveryIntervalMs !== undefined ? { intervalMs: opts.loopRecoveryIntervalMs } : {}),
          })
        : undefined;
  } catch (error) {
    memoryMaintenanceScheduler.dispose();
    throw error;
  }

  let graphMaintenanceScheduler: GraphMaintenanceScheduler | undefined;
  try {
    graphMaintenanceScheduler =
      opts.graphAutoResume || opts.graphAutoPrune
        ? createGraphMaintenanceScheduler({
            targets: () =>
              registry.list.map((workspace) => ({
                workspace: workspace.path,
                maintain: async (signal) => {
                  const attempt = await coordinator.tryWithIdleAgentMutation(
                    workspace.path,
                    signal,
                    async (idleGuard, maintenanceSignal) => {
                      const states = [];
                      if (opts.graphAutoResume) {
                        for (const state of recoverableEngineeringGraphStates(workspace.path, {
                          limit: opts.graphRecoveryMaxPerTick ?? 3,
                        })) {
                          maintenanceSignal.throwIfAborted();
                          try {
                            states.push(
                              await runGraph(
                                {
                                  workspace: workspace.path,
                                  confirm: async () => false,
                                  extractMemory: true,
                                  signal: maintenanceSignal,
                                },
                                state.definition,
                                {
                                  resume: true,
                                  signal: maintenanceSignal,
                                  workspaceGuard: idleGuard,
                                  executors: graphExecutorsFor(workspace.path),
                                },
                              ),
                            );
                          } catch (error) {
                            if (maintenanceSignal.aborted) {
                              if (signal.aborted) throw error;
                              break;
                            }
                            logger.log("error", "graph.recovery.failed", {
                              workspace: workspace.path,
                              graphId: state.graphId,
                              error: error instanceof Error ? error.message : String(error),
                            });
                          }
                        }
                      }
                      if (opts.graphAutoPrune && !maintenanceSignal.aborted) {
                        await pruneEngineeringGraphStates(workspace.path, {
                          maxAgeDays: opts.graphRetentionMaxAgeDays ?? 30,
                          maxTerminalCount: opts.graphRetentionMaxCount ?? 100,
                        });
                      }
                      return states;
                    },
                  );
                  return attempt.acquired ? attempt.value : undefined;
                },
              })),
            onResults: (results) => {
              for (const result of results) {
                if (result.outcome.status === "completed" && result.outcome.states.length > 0) {
                  logger.log("info", "graph.maintenance.completed", {
                    workspace: result.workspace,
                    graphs: result.outcome.states.map((state) => ({ graphId: state.graphId, status: state.status })),
                  });
                } else if (result.outcome.status === "failed") {
                  logger.log("error", "graph.maintenance.failed", {
                    workspace: result.workspace,
                    error: result.outcome.error,
                  });
                }
              }
            },
            ...(opts.graphMaintenanceInitialDelayMs !== undefined
              ? { initialDelayMs: opts.graphMaintenanceInitialDelayMs }
              : {}),
            ...(opts.graphMaintenanceIntervalMs !== undefined ? { intervalMs: opts.graphMaintenanceIntervalMs } : {}),
          })
        : undefined;
  } catch (error) {
    memoryMaintenanceScheduler.dispose();
    loopRecoveryScheduler?.dispose();
    throw error;
  }

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(opts.port ?? 7373, "127.0.0.1", () => {
        server.removeListener("error", rejectListen);
        resolveListen();
      });
    });
  } catch (error) {
    memoryMaintenanceScheduler.dispose();
    loopRecoveryScheduler?.dispose();
    graphMaintenanceScheduler?.dispose();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    memoryMaintenanceScheduler.dispose();
    loopRecoveryScheduler?.dispose();
    graphMaintenanceScheduler?.dispose();
    server.close();
    throw new Error("could not determine the listen port");
  }
  port = address.port;
  logger.log("info", "server.ready", { port, workspaces: registry.summary.length });

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      memoryMaintenanceScheduler.dispose();
      loopRecoveryScheduler?.dispose();
      graphMaintenanceScheduler?.dispose();
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
