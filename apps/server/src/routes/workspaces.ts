/**
 * Workspace routes: the global open/close/recents endpoints (not scoped to a
 * `?ws=` workspace), plus the workspace-scoped worktree-session routes and
 * GET /api/project.
 */

import { basename, resolve as resolvePath } from "node:path";
import { acquireWorkspaceSessionGuard, createDefaultDispatcher, SessionBusyError } from "@seekforge/core";
import { readJsonBody, sendApiError, sendJson } from "../http.js";
import { forgetRecent, isWorkspaceDir, loadRecents, rememberRecent } from "../recents.js";
import { workspaceFor, type WorkspaceRegistry } from "../workspaces.js";
import type { GlobalRouteCtx, RouteCtx } from "./context.js";

/** Recent workspaces not already hosted (so the "open recent" menu has no dupes). */
function recentsView(registry: WorkspaceRegistry): Array<{ path: string; name: string }> {
  const hosted = new Set(registry.summary.map((w) => resolvePath(w.path)));
  return loadRecents()
    .filter((r) => !hosted.has(resolvePath(r.path)))
    .map(({ path, name }) => ({ path, name }));
}

// One readonly dispatcher instance for GET /api/project.
const dispatcher = createDefaultDispatcher();

async function detectProject(workspace: string): Promise<unknown> {
  const result = await dispatcher.execute(
    { id: "server-detect", name: "detect_project", arguments: {} },
    {
      sessionId: "server",
      workspace,
      policy: { approvalMode: "auto", mode: "ask", commandAllowlist: [] },
      confirm: async () => false,
    },
  );
  const data = (result.ok ? result.data : {}) as {
    name?: string;
    languages?: string[];
    packageManager?: string;
    frameworks?: string[];
    scripts?: Record<string, string>;
  };
  return {
    path: workspace,
    name: data.name ?? basename(workspace),
    detect: {
      languages: data.languages ?? [],
      packageManager: data.packageManager ?? null,
      frameworks: data.frameworks ?? [],
      scripts: data.scripts ?? {},
    },
  };
}

/**
 * Global workspace routes (run BEFORE `?ws=` resolution). Returns true when a
 * route matched (matched routes always answer — or throw — before returning,
 * so "response started" is exactly "matched").
 */
export async function handleGlobal(ctx: GlobalRouteCtx): Promise<boolean> {
  await globalRoutes(ctx);
  return ctx.res.headersSent;
}

async function globalRoutes({ req, res, url, method, segs, rest }: GlobalRouteCtx): Promise<void> {
  const path = url.pathname;

  if (method === "GET" && path === "/api/workspaces") {
    return sendJson(res, 200, { workspaces: rest.registry.summary, recents: recentsView(rest.registry) });
  }

  // Open a folder as a workspace: register it (idempotent) and remember it.
  if (method === "POST" && path === "/api/workspaces") {
    const body = await readJsonBody(req, res, { emptyOk: true });
    if (body === undefined) return;
    const p = ((body ?? {}) as { path?: unknown }).path;
    if (typeof p !== "string" || p.trim() === "") {
      return sendApiError(res, 400, "bad_request", "body must be {path: string}");
    }
    if (!isWorkspaceDir(p)) {
      return sendApiError(res, 400, "bad_request", `not a directory: ${p}`);
    }
    const ws = workspaceFor(p);
    if (!rest.registry.resolve(ws.id)) rest.registry.register(ws);
    rememberRecent(ws.path);
    return sendJson(res, 200, {
      workspace: { id: ws.id, name: ws.name, path: ws.path },
      workspaces: rest.registry.summary,
      recents: recentsView(rest.registry),
    });
  }

  // Forget a recent path (does not touch hosting). Checked before :id below.
  if (method === "DELETE" && segs.length === 3 && segs[1] === "workspaces" && segs[2] === "recent") {
    const p = url.searchParams.get("path");
    if (!p) return sendApiError(res, 400, "bad_request", "missing ?path=");
    forgetRecent(p);
    return sendJson(res, 200, { workspaces: rest.registry.summary, recents: recentsView(rest.registry) });
  }

  // Stop hosting a workspace (the launch/default workspace cannot be removed).
  if (method === "DELETE" && segs.length === 3 && segs[1] === "workspaces") {
    // Worktree identity comes from the authoritative manager, not the display
    // id prefix: an ordinary hashed workspace id can also begin with `wt-`.
    if (rest.worktrees.get(segs[2]!) !== undefined) {
      return sendApiError(res, 400, "bad_request", "use DELETE /api/worktrees/:id to remove a worktree");
    }
    const target = rest.registry.resolve(segs[2]!);
    if (!target) return sendApiError(res, 404, "not_found", `unknown workspace: ${segs[2]}`);
    let guard: ReturnType<typeof acquireWorkspaceSessionGuard> | undefined;
    try {
      if (target) guard = acquireWorkspaceSessionGuard(target.path);
      rest.registry.unregister(segs[2]!);
    } catch (e) {
      if (e instanceof SessionBusyError) {
        return sendApiError(res, 409, "session_busy", `workspace has an active session: ${segs[2]}`);
      }
      return sendApiError(res, 400, "bad_request", e instanceof Error ? e.message : String(e));
    } finally {
      guard?.release();
    }
    return sendJson(res, 200, { workspaces: rest.registry.summary, recents: recentsView(rest.registry) });
  }
}

/** Workspace-scoped routes: worktree sessions + GET /api/project. */
export async function handle(ctx: RouteCtx): Promise<boolean> {
  await routes(ctx);
  return ctx.res.headersSent;
}

async function routes({ req, res, url, method, segs, ws, workspace, rest }: RouteCtx): Promise<void> {
  const path = url.pathname;

  // Worktree sessions — `?ws=` selects the BASE workspace for create/list;
  // merge/delete identify the worktree by :id (its own record knows the base).
  if (path === "/api/worktrees" && method === "GET") {
    return sendJson(res, 200, await rest.worktrees.list(ws));
  }

  if (path === "/api/worktrees" && method === "POST") {
    // An empty body is allowed (auto-generated worktree name).
    const body = await readJsonBody(req, res, { emptyOk: true });
    if (body === undefined) return;
    const candidate = (body ?? {}) as { name?: unknown };
    if (candidate.name !== undefined && typeof candidate.name !== "string") {
      return sendApiError(res, 400, "bad_request", "body must be {name?: string}");
    }
    return sendJson(res, 200, await rest.worktrees.create(ws, candidate.name));
  }

  if (method === "POST" && segs.length === 4 && segs[1] === "worktrees" && segs[3] === "merge") {
    return sendJson(res, 200, await rest.worktrees.merge(segs[2]!));
  }

  if (method === "DELETE" && segs.length === 3 && segs[1] === "worktrees") {
    await rest.worktrees.remove(segs[2]!);
    return sendJson(res, 200, { deleted: true });
  }

  if (method === "GET" && path === "/api/project") {
    return sendJson(res, 200, await detectProject(workspace));
  }
}
