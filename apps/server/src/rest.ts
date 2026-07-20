/**
 * REST endpoints under /api (SERVER-API.md). All responses are JSON;
 * errors are {error: {code, message}} with an appropriate HTTP status.
 *
 * The routes themselves live in the route-group modules under routes/ (git,
 * sessions, files, skills-agents, memory, triggers, workspaces, settings);
 * handleApi keeps only the global health/models endpoints, the `?ws=`
 * workspace resolution, the dispatch loop, and the central error mapping.
 * The groups partition the /api path space disjointly, so only the order
 * WITHIN a group is ever load-bearing (the "Checked before …" comments live
 * next to their routes).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_MODEL, DEPRECATED_MODELS, MODEL_PRICING, resolveProviderPreset } from "@seekforge/core";
import { ConfigValueError, loadConfig } from "./config.js";
import { FileBrowseError, RawFileError, UploadError } from "./files.js";
import { sendApiError, sendJson } from "./http.js";
import type { GlobalRouteCtx, RestContext, RouteCtx } from "./routes/context.js";
import * as filesRoutes from "./routes/files.js";
import * as gitRoutes from "./routes/git.js";
import * as memoryRoutes from "./routes/memory.js";
import * as runRoutes from "./routes/runs.js";
import * as sessionRoutes from "./routes/sessions.js";
import * as securityRoutes from "./routes/security.js";
import * as settingsRoutes from "./routes/settings.js";
import * as skillsAgentsRoutes from "./routes/skills-agents.js";
import * as triggerRoutes from "./routes/triggers.js";
import * as workspaceRoutes from "./routes/workspaces.js";
import { WorktreeError } from "./worktrees.js";
import { SERVER_CAPABILITIES, SERVER_PROTOCOL_VERSION } from "./run-ledger.js";

// Re-exports for embedders/back-compat: index.ts imports the senders from
// here, and RestContext/ApprovedFact were historically part of this module.
export { sendApiError, sendJson } from "./http.js";
export type { RestContext } from "./routes/context.js";
export type { ApprovedFact } from "./routes/memory.js";

/**
 * Workspace-scoped route groups, offered a RouteCtx in this order; the first
 * group whose handle() returns true has answered the request. Order between
 * groups is not load-bearing (disjoint path prefixes) but mirrors the
 * pre-split route order for easy diffing.
 */
const ROUTE_GROUPS: ReadonlyArray<(ctx: RouteCtx) => Promise<boolean>> = [
  workspaceRoutes.handle, // worktrees + /api/project
  runRoutes.handle,
  triggerRoutes.handle,
  sessionRoutes.handle,
  filesRoutes.handle,
  gitRoutes.handle,
  skillsAgentsRoutes.handle,
  memoryRoutes.handle,
  securityRoutes.handle,
  settingsRoutes.handle,
];

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, ctx: RestContext): Promise<void> {
  const method = req.method ?? "GET";
  const path = url.pathname;
  // ["api", ...rest] — path params are URL-decoded per segment. Malformed
  // percent-encoding (e.g. "/api/%E0%A4%A") makes decodeURIComponent throw, so
  // guard it and answer 400 rather than rejecting before the try below.
  let segs: string[];
  try {
    segs = path.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return sendApiError(res, 400, "bad_request", "malformed URL path");
  }

  try {
    // Global routes (not scoped to a workspace).
    if (method === "GET" && path === "/api/health") {
      return sendJson(res, 200, {
        version: ctx.version,
        protocolVersion: SERVER_PROTOCOL_VERSION,
        capabilities: SERVER_CAPABILITIES,
        ready: true,
        workspace: ctx.registry.default.path,
        workspaces: ctx.registry.summary,
      });
    }

    if (method === "GET" && path === "/api/ready") {
      return sendJson(res, 200, { ready: true, version: ctx.version });
    }

    if (method === "GET" && path === "/api/metrics") {
      const metrics = ctx.runManager.metrics();
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(
        `${Object.entries(metrics)
          .map(([name, value]) => `${name} ${value}`)
          .join("\n")}\n`,
      );
      return;
    }

    if (method === "GET" && path === "/api/models") {
      // The active provider is the default workspace's configured provider. A
      // named provider with its own catalog that isn't the DeepSeek pricing set
      // (e.g. Ark) returns its model ids with no pricing table.
      const provider = loadConfig(ctx.registry.default.path).provider;
      const preset = resolveProviderPreset(provider);
      if (preset && provider?.toLowerCase() !== "deepseek") {
        const models = preset.models.map((id) => ({
          id,
          isDefault: id === DEFAULT_MODEL,
          deprecated: DEPRECATED_MODELS.includes(id as never),
          pricing: null,
        }));
        return sendJson(res, 200, models);
      }
      const models = Object.entries(MODEL_PRICING).map(([id, pricing]) => ({
        id,
        isDefault: id === DEFAULT_MODEL,
        deprecated: DEPRECATED_MODELS.includes(id as never),
        pricing,
      }));
      return sendJson(res, 200, models);
    }

    // Global workspace open/close/recents routes.
    const globalCtx: GlobalRouteCtx = { req, res, url, method, segs, rest: ctx };
    if (await workspaceRoutes.handleGlobal(globalCtx)) return;

    // Every remaining route is scoped to a workspace selected by `?ws=<id>`
    // (default = first workspace when omitted, preserving old clients).
    const wsId = url.searchParams.get("ws");
    const ws = ctx.registry.resolve(wsId);
    if (!ws) {
      return sendApiError(res, 404, "not_found", `unknown workspace: ${String(wsId)}`);
    }

    const routeCtx: RouteCtx = { ...globalCtx, ws, workspace: ws.path };
    for (const handle of ROUTE_GROUPS) {
      if (await handle(routeCtx)) return;
    }

    return sendApiError(res, 404, "not_found", `no such endpoint: ${method} ${path}`);
  } catch (err) {
    // Known error classes carry their own {status, code, message} — map each
    // to its structured API error. Routes throw these freely (no per-route
    // try/catch needed).
    if (
      err instanceof WorktreeError ||
      err instanceof FileBrowseError ||
      err instanceof RawFileError ||
      err instanceof UploadError
    ) {
      return sendApiError(res, err.status, err.code, err.message);
    }
    // ConfigValueError has no status/code of its own: always a client error.
    if (err instanceof ConfigValueError) {
      return sendApiError(res, 400, "bad_request", err.message);
    }
    // Anything else is an internal failure. Log the full error server-side but
    // answer a generic message — raw internal error text (paths, stack
    // fragments, stderr) is not for clients. Log through the structured logger
    // with the requestId so the 500 can be joined to its http.request line.
    if (ctx.logger) {
      ctx.logger.log("error", "api.error", {
        requestId: ctx.requestId,
        method,
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    } else {
      console.error(`[api] ${method} ${path} failed:`, err);
    }
    return sendApiError(res, 500, "internal", "internal error");
  }
}
