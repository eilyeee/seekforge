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
import type { CreateAgentFn, RunLoopFn } from "../agent.js";
import type { ServerCoordinator } from "../coordinator.js";
import type { Workspace, WorkspaceRegistry } from "../workspaces.js";
import type { WorktreeManager } from "../worktrees.js";
import type { TriggerRunHandle } from "../trigger-run.js";
import type { RunManager } from "../run-ledger.js";

export type RestContext = {
  registry: WorkspaceRegistry;
  worktrees: WorktreeManager;
  coordinator: ServerCoordinator;
  version: string;
  /**
   * Agent factory used by the webhook trigger endpoint to start a headless,
   * cost-bounded run. Injectable so tests can supply a fake (no real LLM call).
   */
  createAgent: CreateAgentFn;
  runLoop: RunLoopFn;
  /** Active headless runs, owned by startServer and drained during shutdown. */
  triggerRuns?: Set<TriggerRunHandle>;
  runManager: RunManager;
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
