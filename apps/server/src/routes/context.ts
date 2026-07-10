/**
 * Shared plumbing for the /api route-group modules (routes/*.ts).
 *
 * handleApi (rest.ts) parses the URL, answers the global routes, resolves the
 * `?ws=` workspace, then offers a RouteCtx to each group's `handle()` in
 * order; the first group that matches answers the response and returns true.
 * The route groups partition the /api path space disjointly, so group order
 * never changes which route wins — only the order WITHIN a group matters
 * (see the "Checked before …" comments kept next to their routes).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { CreateAgentFn } from "../agent.js";
import type { Workspace, WorkspaceRegistry } from "../workspaces.js";
import type { WorktreeManager } from "../worktrees.js";

export type RestContext = {
  registry: WorkspaceRegistry;
  worktrees: WorktreeManager;
  version: string;
  /**
   * Agent factory used by the webhook trigger endpoint to start a headless,
   * cost-bounded run. Injectable so tests can supply a fake (no real LLM call).
   */
  createAgent: CreateAgentFn;
};

/** Context for the global (non-workspace-scoped) routes. */
export type GlobalRouteCtx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  /** ["api", ...rest] — path segments, URL-decoded per segment. */
  segs: string[];
  rest: RestContext;
};

/** Context for workspace-scoped routes (everything behind `?ws=`). */
export type RouteCtx = GlobalRouteCtx & {
  /** The resolved workspace record (worktree create/list need the record). */
  ws: Workspace;
  /** Absolute path of the resolved workspace. */
  workspace: string;
};
