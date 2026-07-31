import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isRecord } from "../util/guards.js";
import {
  type EngineeringGraphDefinition,
  graphNodeIsEffectful,
  isValidEngineeringGraphNodePath,
  MAX_GRAPH_NODES,
} from "./graph-contract.js";
import {
  graphExecutionAdapterEligibility,
  graphExecutor,
  graphHandler,
  type RunEngineeringGraphOptions,
} from "./graph-execution-contract.js";
import { isValidLoopDagId } from "./loop-dag-validation.js";
import {
  assertNonOverlappingOrchestrationPaths,
  orchestrationDependsOn,
  validateOrchestrationSelection,
} from "./orchestration.js";

/**
 * Complete validation of a Graph run request, run before any lease, provider,
 * or worktree is touched: an invalid request must fail without side effects.
 */
export function validateEngineeringGraphRunOptions(
  definition: EngineeringGraphDefinition,
  options: RunEngineeringGraphOptions,
): void {
  for (const [name, value] of [
    ["resume", options.resume],
    ["restart", options.restart],
    ["persist", options.persist],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") throw new Error(`Graph ${name} must be boolean`);
  }
  if (options.resume && options.restart) throw new Error("Graph resume and restart cannot be combined");
  if (
    options.costBudgetUsd !== undefined &&
    (typeof options.costBudgetUsd !== "number" || !Number.isFinite(options.costBudgetUsd) || options.costBudgetUsd <= 0)
  ) {
    throw new Error("Graph operational costBudgetUsd must be positive and finite");
  }
  if (
    options.tokenBudget !== undefined &&
    (typeof options.tokenBudget !== "number" || !Number.isSafeInteger(options.tokenBudget) || options.tokenBudget < 1)
  ) {
    throw new Error("Graph operational tokenBudget must be a positive safe integer");
  }
  if (
    options.parentGraph !== undefined &&
    (!isRecord(options.parentGraph) ||
      !isValidLoopDagId(options.parentGraph.graphId) ||
      !isValidLoopDagId(options.parentGraph.nodeId))
  ) {
    throw new Error("Graph parentGraph provenance is invalid");
  }
  if (options.recoveryAttemptId !== undefined && !isValidLoopDagId(options.recoveryAttemptId)) {
    throw new Error("Graph recoveryAttemptId is invalid");
  }
  const declaredNodes = new Set<string>();
  const gateIds = new Set<string>();
  const collectPaths = (graph: EngineeringGraphDefinition, prefix = ""): void => {
    for (const node of graph.nodes) {
      const path = `${prefix}${node.id}`;
      declaredNodes.add(path);
      if (node.kind === "gate") gateIds.add(path);
      if (node.graph) collectPaths(node.graph, `${path}/`);
    }
  };
  collectPaths(definition);
  const rerunFrom = validateOrchestrationSelection(options.rerunFrom, {
    label: "Graph rerunFrom",
    max: MAX_GRAPH_NODES,
    knownIds: declaredNodes,
    isValidId: isValidEngineeringGraphNodePath,
    allowUndefined: true,
    allowEmpty: true,
  });
  validateOrchestrationSelection(options.approvedNodeIds, {
    label: "Graph approvedNodeIds",
    max: MAX_GRAPH_NODES,
    knownIds: gateIds,
    isValidId: isValidEngineeringGraphNodePath,
    allowUndefined: true,
    allowEmpty: true,
  });
  if (rerunFrom.length && !options.resume) throw new Error("Graph rerunFrom requires resume");
  if (options.persist === false && definition.nodes.some((node) => node.kind === "wait")) {
    throw new Error("Graph wait nodes require persistence");
  }
  const validateHandlers = (graph: EngineeringGraphDefinition): void => {
    for (const node of graph.nodes) {
      if (
        (node.kind === "function" ||
          (node.kind === "map" && (node.mapKind ?? "handler") === "handler") ||
          node.kind === "compensation") &&
        !graphHandler(options, node.handler!)
      ) {
        throw new Error(`Graph function handler is not registered: ${node.handler}`);
      }
      if (node.kind === "remote") {
        const adapter = graphExecutor(options, node.executor!);
        const eligibility = graphExecutionAdapterEligibility(node, adapter);
        if (eligibility.status !== "eligible") {
          throw new Error(`Graph remote executor ${node.executor} is ineligible: ${eligibility.reasons.join("; ")}`);
        }
      }
      if (node.graph) validateHandlers(node.graph);
    }
  };
  validateHandlers(definition);
}

export function validateEngineeringGraphWorkspaces(definition: EngineeringGraphDefinition, workspace: string): void {
  if (definition.managedWorktrees) {
    realpathSync.native(resolve(workspace));
    return;
  }
  resolveEngineeringGraphWorkspaces(workspace, definition);
}

/** Resolves the physical workspace identity used by Graph fingerprints. */
export function resolveEngineeringGraphWorkspaces(
  rootInput: string,
  definition: EngineeringGraphDefinition,
  overrides: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const root = realpathSync.native(resolve(rootInput));
  const workspaces = new Map<string, string>();
  const visit = (graph: EngineeringGraphDefinition, graphRoot: string, prefix: string): void => {
    for (const node of graph.nodes) {
      const key = `${prefix}${node.id}`;
      const override = overrides.get(key);
      const requested =
        override ??
        (node.workspace
          ? isAbsolute(node.workspace)
            ? node.workspace
            : resolve(graphRoot, node.workspace)
          : graphRoot);
      const rel = relative(graphRoot, resolve(requested));
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`Graph node ${key} workspace escapes the graph workspace`);
      }
      const stat = lstatSync(requested);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Graph node ${key} workspace must be a physical directory`);
      }
      const physical = realpathSync.native(requested);
      if (physical !== graphRoot && !physical.startsWith(`${graphRoot}${sep}`)) {
        throw new Error(`Graph node ${key} workspace escapes the graph workspace`);
      }
      workspaces.set(key, physical);
      if (node.graph) visit(node.graph, physical, `${key}/`);
    }
    if ((graph.maxConcurrency ?? 1) > 1) {
      const effectful = graph.nodes.filter(graphNodeIsEffectful);
      for (let leftIndex = 0; leftIndex < effectful.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < effectful.length; rightIndex++) {
          const left = effectful[leftIndex]!;
          const right = effectful[rightIndex]!;
          if (orchestrationDependsOn(graph.nodes, left.id, right.id)) continue;
          if (orchestrationDependsOn(graph.nodes, right.id, left.id)) continue;
          assertNonOverlappingOrchestrationPaths(
            [workspaces.get(`${prefix}${left.id}`)!, workspaces.get(`${prefix}${right.id}`)!],
            "Concurrent effectful Graph nodes must use non-overlapping physical workspaces",
          );
        }
      }
    }
  };
  visit(definition, root, "");
  return workspaces;
}
