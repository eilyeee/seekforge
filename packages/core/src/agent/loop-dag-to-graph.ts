import { createHash } from "node:crypto";
import {
  type EngineeringGraphDefinition,
  type GraphCondition,
  type GraphNode,
  parseEngineeringGraphDefinition,
} from "./graph-contract.js";
import type { LoopDagCondition, LoopDagOptions } from "./loop-dag.js";
import { assertValidLoopDagNodes, isValidLoopDagId, loopDagConditionReferences } from "./loop-dag-validation.js";

/**
 * Deterministic migration from a Loop DAG definition to the equivalent
 * Engineering Graph definition, where every Loop DAG node becomes one
 * `kind: "loop"` node.
 *
 * The Loop DAG is an isomorphic shortcut for one Graph shape, so this
 * conversion is only useful if it is honest: a field the Graph contract cannot
 * express must fail loudly instead of being dropped into a graph that looks
 * equivalent and behaves differently. Every difference is therefore classified
 * as `blocking` (throws) or `advisory` (returned), and nothing is silent.
 */

/** Loop DAG options minus the callbacks and handles a definition cannot carry. */
export type LoopDagGraphSource = Omit<
  LoopDagOptions,
  "workspace" | "signal" | "workspaceForNode" | "approveNode" | "onNodeEvent" | "onFanIn"
> & {
  /** Run-time root; the Graph carries no workspace, so it is reported, not encoded. */
  workspace?: string;
  /** Serializable stand-in for `LoopDagOptions.workspaceForNode`. */
  workspaceForNode?: Readonly<Record<string, string>>;
};

export type LoopDagGraphIssueSeverity = "blocking" | "advisory";

export type LoopDagGraphIssueCode =
  | "node_options_unsupported"
  | "consume_dependency_outputs"
  | "output_paths"
  | "verifier_id"
  | "budget_weight"
  | "predictive_budget"
  | "mixed_failure_policy"
  | "condition_too_wide"
  | "approval_gate_id"
  | "max_duration_range"
  | "managed_worktree_workspaces"
  | "concurrency_isolation"
  | "fan_in_requires_worktrees"
  | "retry_backoff"
  | "scheduling_tiebreak"
  | "managed_worktree_limit"
  | "approval_surface"
  | "approval_pause_scope"
  | "run_option"
  | "graph_identity"
  | "inert_budget_weight"
  | "inert_predictive_budget";

export type LoopDagGraphIssue = {
  code: LoopDagGraphIssueCode;
  severity: LoopDagGraphIssueSeverity;
  /** Loop DAG field this issue is about, e.g. `nodes[].outputPaths`. */
  field: string;
  message: string;
  nodeId?: string;
};

export class LoopDagGraphConversionError extends Error {
  readonly issues: readonly LoopDagGraphIssue[];

  constructor(issues: readonly LoopDagGraphIssue[]) {
    super(
      `Loop DAG cannot be converted to an equivalent Engineering Graph:\n${issues
        .map((issue) => `- ${issue.nodeId ? `${issue.nodeId}: ` : ""}${issue.field} — ${issue.message}`)
        .join("\n")}`,
    );
    this.name = "LoopDagGraphConversionError";
    this.issues = issues;
  }
}

export type LoopDagGraphNodeMapping = {
  /** Graph node that runs the Loop. */
  loopNodeId: string;
  /** Injected gate node when the Loop DAG node declared `requiresApproval`. */
  approvalGateId?: string;
};

export type LoopDagGraphConversion = {
  definition: EngineeringGraphDefinition;
  /** Loop DAG node id to the Graph nodes that implement it. */
  nodes: Record<string, LoopDagGraphNodeMapping>;
  /** Differences that survive the conversion; never empty when behavior shifts. */
  warnings: LoopDagGraphIssue[];
};

export type LoopDagGraphConversionOptions = {
  /** Graph id; defaults to `dagId`, then to a deterministic content fingerprint. */
  graphId?: string;
  /** Suffix for injected approval gates. Default `approval`. */
  approvalGateSuffix?: string;
};

/**
 * The Loop DAG retries a failed node immediately. The Graph applies exponential
 * backoff unless the node pins a policy, so an equivalent node pins the
 * smallest legal delay instead of inheriting a one-second first backoff.
 */
const IMMEDIATE_RETRY_POLICY = { initialDelayMs: 1, maxDelayMs: 1, multiplier: 1, jitterRatio: 0 } as const;

/** Loop options a Graph `loop` node forwards to its child Loop. */
const SUPPORTED_NODE_OPTION_KEYS = new Set(["approvalMode"]);

const MAX_GRAPH_CONDITION_CHILDREN = 32;
const MAX_LOOP_DAG_ID_LENGTH = 64;

function graphCondition(condition: LoopDagCondition): GraphCondition {
  if ("nodeId" in condition) return { nodeId: condition.nodeId, status: condition.status };
  if ("not" in condition) return { not: graphCondition(condition.not) };
  if ("all" in condition) return { all: condition.all.map(graphCondition) };
  return { any: condition.any.map(graphCondition) };
}

function sourceFingerprint(source: LoopDagGraphSource): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        nodes: source.nodes,
        maxConcurrency: source.maxConcurrency ?? 1,
        costBudgetUsd: source.costBudgetUsd,
        tokenBudget: source.tokenBudget,
        maxDurationMs: source.maxDurationMs,
        managedWorktrees: source.managedWorktrees ?? false,
        managedWorktreeLimit: source.managedWorktreeLimit,
        fanIn: source.fanIn,
        workspaceForNode: Object.entries(source.workspaceForNode ?? {}).sort(),
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

/**
 * Converts a Loop DAG definition into an Engineering Graph definition that
 * schedules, gates, budgets, and fails over identically. Pure: it reads no
 * file, resolves no path, and acquires no lease.
 *
 * @throws LoopDagGraphConversionError when any field has no equivalent.
 */
export function engineeringGraphFromLoopDag(
  source: LoopDagGraphSource,
  options: LoopDagGraphConversionOptions = {},
): LoopDagGraphConversion {
  assertValidLoopDagNodes(source.nodes);
  const blocking: LoopDagGraphIssue[] = [];
  const warnings: LoopDagGraphIssue[] = [];
  const block = (issue: Omit<LoopDagGraphIssue, "severity">): void => {
    blocking.push({ ...issue, severity: "blocking" });
  };
  const warn = (issue: Omit<LoopDagGraphIssue, "severity">): void => {
    warnings.push({ ...issue, severity: "advisory" });
  };

  const byId = new Map(source.nodes.map((node) => [node.id, node]));
  const declaredIds = new Set(byId.keys());
  const workspaceForNode = source.workspaceForNode ?? {};
  const hasNodeWorkspaces = Object.keys(workspaceForNode).length > 0;
  for (const nodeId of Object.keys(workspaceForNode)) {
    if (!declaredIds.has(nodeId)) {
      block({
        code: "concurrency_isolation",
        field: "workspaceForNode",
        nodeId,
        message: "workspaceForNode names a node that the Loop DAG does not declare",
      });
    }
  }

  const graphId = options.graphId ?? source.dagId ?? `dag-${sourceFingerprint(source)}`;
  if (!isValidLoopDagId(graphId)) {
    block({ code: "graph_identity", field: "dagId", message: `Graph id is not a safe identifier: ${graphId}` });
  }
  if (options.graphId === undefined && source.dagId === undefined) {
    warn({
      code: "graph_identity",
      field: "dagId",
      message: `The Loop DAG derives its id from resolved node workspaces, which a pure conversion cannot read; the Graph uses the content-derived id ${graphId}. Pass graphId to pin it.`,
    });
  }

  const runOptions = [
    ...(source.workspace !== undefined ? ["workspace"] : []),
    ...(source.resume !== undefined ? ["resume"] : []),
    ...(source.persist !== undefined ? ["persist"] : []),
    ...(source.rerunFrom !== undefined ? ["rerunFrom"] : []),
  ];
  if (runOptions.length > 0) {
    warn({
      code: "run_option",
      field: runOptions.join(", "),
      message:
        "These are run options, not definition fields. Pass them to runEngineeringGraph (workspace, resume, persist, rerunFrom) instead; they are not encoded in the exported Graph.",
    });
  }

  // --- Failure policy: per node in the Loop DAG, per graph in the Graph. ---
  const stopNodes = source.nodes.filter((node) => node.failurePolicy === "stop").map((node) => node.id);
  if (stopNodes.length > 0 && stopNodes.length !== source.nodes.length) {
    block({
      code: "mixed_failure_policy",
      field: "nodes[].failurePolicy",
      message: `The Graph owns one failurePolicy for the whole run, so "stop" cannot apply to a subset. Nodes declaring "stop": ${stopNodes.join(", ")}. Give every node "stop", or none.`,
    });
  }
  const failurePolicy: NonNullable<EngineeringGraphDefinition["failurePolicy"]> =
    stopNodes.length === source.nodes.length ? "stop" : "continue";

  // --- Shared budgets: the Loop DAG weights node shares, the Graph splits evenly. ---
  const hasSharedBudget = source.costBudgetUsd !== undefined || source.tokenBudget !== undefined;
  const weights = source.nodes.map((node) => node.budgetWeight ?? 1);
  const unevenWeights = weights.some((weight) => weight !== weights[0]);
  if (unevenWeights && hasSharedBudget) {
    block({
      code: "budget_weight",
      field: "nodes[].budgetWeight",
      message:
        "The Graph splits the remaining shared budget evenly across the nodes it launches together and has no per-node weight. Remove budgetWeight, or give every node the same weight.",
    });
  } else if (unevenWeights) {
    warn({
      code: "inert_budget_weight",
      field: "nodes[].budgetWeight",
      message:
        "budgetWeight only reweights a shared cost/token budget, and this DAG declares none, so the differing weights are inert and are not encoded in the Graph.",
    });
  }
  if (source.predictiveBudget === true) {
    if (hasSharedBudget) {
      block({
        code: "predictive_budget",
        field: "predictiveBudget",
        message:
          "The Graph has no historical budget reweighting. Its adaptiveScheduling learns scheduling order, not budget shares, so it is not an equivalent substitute.",
      });
    } else {
      warn({
        code: "inert_predictive_budget",
        field: "predictiveBudget",
        message:
          "predictiveBudget only reweights a shared cost/token budget, and this DAG declares none, so it is inert and is not encoded in the Graph.",
      });
    }
  }
  if (source.maxDurationMs !== undefined && source.maxDurationMs > 24 * 60 * 60 * 1000) {
    block({
      code: "max_duration_range",
      field: "maxDurationMs",
      message: `The Graph caps maxDurationMs at 24 hours; the Loop DAG requests ${source.maxDurationMs}ms.`,
    });
  }

  // --- Isolation. ---
  if (source.managedWorktrees && hasNodeWorkspaces) {
    block({
      code: "managed_worktree_workspaces",
      field: "managedWorktrees",
      message: "Managed worktrees cannot be combined with explicit node workspaces in either runtime.",
    });
  }
  const concurrency = source.maxConcurrency ?? 1;
  if (concurrency > 1 && !source.managedWorktrees && !hasNodeWorkspaces) {
    block({
      code: "concurrency_isolation",
      field: "maxConcurrency",
      message:
        "Concurrent nodes require managedWorktrees or one workspace per node; without isolation the Graph rejects the run just as the Loop DAG does.",
    });
  }
  if (source.fanIn !== undefined && !source.managedWorktrees) {
    block({
      code: "fan_in_requires_worktrees",
      field: "fanIn",
      message: "fanIn requires managedWorktrees in both runtimes.",
    });
  }
  if (source.managedWorktrees && source.managedWorktreeLimit === undefined) {
    warn({
      code: "managed_worktree_limit",
      field: "managedWorktreeLimit",
      message:
        "The Loop DAG leaves the repository-wide managed worktree count unbounded; the Graph always enforces a limit, so the conversion pins the maximum of 256.",
    });
  }
  if (concurrency > 1) {
    warn({
      code: "scheduling_tiebreak",
      field: "maxConcurrency",
      message:
        "Equal-priority ready nodes are ordered by node id in the Loop DAG and by dependency criticality (then id) in the Graph. The set of runnable nodes is identical; which one takes a scarce slot first can differ.",
    });
  }

  // --- Per node. ---
  const gateIds = new Map<string, string>();
  const suffix = options.approvalGateSuffix ?? "approval";
  for (const node of source.nodes) {
    if (node.requiresApproval !== true) continue;
    const gateId = `${node.id}-${suffix}`;
    if (!isValidLoopDagId(gateId) || gateId.length > MAX_LOOP_DAG_ID_LENGTH || declaredIds.has(gateId)) {
      block({
        code: "approval_gate_id",
        field: "nodes[].requiresApproval",
        nodeId: node.id,
        message: `The Graph expresses approval as a separate gate node, and the derived id ${gateId} is invalid, too long, or already taken. Rename the node or pass approvalGateSuffix.`,
      });
      continue;
    }
    gateIds.set(node.id, gateId);
  }
  if (gateIds.size > 0) {
    warn({
      code: "approval_surface",
      field: "nodes[].requiresApproval",
      message: `Approval moves from the Loop DAG's approveNode(node) callback to gate nodes: ${[...gateIds]
        .map(([nodeId, gateId]) => `${nodeId} -> ${gateId}`)
        .join(", ")}. Approve those gate ids, not the Loop node ids.`,
    });
    warn({
      code: "approval_pause_scope",
      field: "nodes[].requiresApproval",
      message:
        "An unapproved node pauses only that branch in the Loop DAG, which keeps scheduling independent nodes for the rest of the invocation; the Graph returns as soon as a gate is unapproved. Both need the same resume to finish, but one invocation covers less ground.",
    });
  }

  const graphNodes: GraphNode[] = [];
  const mapping: Record<string, LoopDagGraphNodeMapping> = {};
  let anyRetries = false;
  for (const node of source.nodes) {
    const unsupportedOptions = Object.keys(node.options ?? {}).filter((key) => !SUPPORTED_NODE_OPTION_KEYS.has(key));
    if (unsupportedOptions.length > 0) {
      block({
        code: "node_options_unsupported",
        field: "nodes[].options",
        nodeId: node.id,
        message: `A Graph loop node forwards only ${[...SUPPORTED_NODE_OPTION_KEYS].join(", ")} to its child Loop. These options have no Graph equivalent and would silently stop applying: ${unsupportedOptions.join(", ")}.`,
      });
    }
    if (node.verifierId !== undefined) {
      block({
        code: "verifier_id",
        field: "nodes[].verifierId",
        nodeId: node.id,
        message:
          "verifierId binds a caller-supplied verify implementation across resumes. A Graph loop node always runs the declared verifyCommand through the real verifier.",
      });
    }
    if (node.consumeDependencyOutputs === true) {
      block({
        code: "consume_dependency_outputs",
        field: "nodes[].consumeDependencyOutputs",
        nodeId: node.id,
        message:
          "The Loop DAG appends structured dependency outputs to the node's task at run time. The Graph resolves `inputs` only for function/map/remote handlers; a loop node's task is used verbatim, so the dependency context would disappear.",
      });
    }
    if (node.outputPaths !== undefined) {
      block({
        code: "output_paths",
        field: "nodes[].outputPaths",
        nodeId: node.id,
        message:
          "outputPaths asserts declared files exist after a node passes and records them as artifacts. The Graph captures artifacts only from what a function/map/remote handler returns, so a loop node cannot promise or verify them.",
      });
    }
    if ((node.maxRetries ?? 0) > 0) anyRetries = true;

    const dependsOn = [...(node.dependsOn ?? [])];
    const conditionRefs = new Set(node.condition ? (loopDagConditionReferences(node.condition) ?? []) : []);
    // Dependencies the Loop DAG condition already governs keep their condition
    // semantics; the rest keep the pass-or-skip rule the DAG applies to them.
    const continuing = (dependency: string): boolean => byId.get(dependency)?.failurePolicy === "continue";
    const guards: GraphCondition[] = dependsOn
      .filter((dependency) => !conditionRefs.has(dependency))
      .map((dependency) =>
        continuing(dependency)
          ? {
              any: [
                { nodeId: dependency, status: "passed" },
                { nodeId: dependency, status: "failed" },
              ],
            }
          : { nodeId: dependency, status: "passed" },
      );
    const needsCondition = node.condition !== undefined || dependsOn.some(continuing);
    let condition: GraphCondition | undefined;
    if (needsCondition) {
      const children = [...(node.condition ? [graphCondition(node.condition)] : []), ...guards];
      if (children.length > MAX_GRAPH_CONDITION_CHILDREN) {
        block({
          code: "condition_too_wide",
          field: "nodes[].condition",
          nodeId: node.id,
          message: `Expressing this node's dependency policy needs ${children.length} Graph condition terms; the Graph allows at most ${MAX_GRAPH_CONDITION_CHILDREN}.`,
        });
      }
      condition = children.length === 1 ? children[0]! : { all: children };
    }

    const gateId = gateIds.get(node.id);
    if (gateId) {
      graphNodes.push({
        id: gateId,
        kind: "gate",
        ...(dependsOn.length > 0 ? { dependsOn: [...dependsOn] } : {}),
        ...(condition ? { condition } : {}),
      });
      // The gate already carries the dependency policy; the Loop node only has
      // to observe the gate, and keeps its own dependencies for ordering and
      // managed-worktree integration.
      condition = { nodeId: gateId, status: "passed" };
      dependsOn.push(gateId);
    }

    const workspace = workspaceForNode[node.id];
    graphNodes.push({
      id: node.id,
      kind: "loop",
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      ...(condition ? { condition } : {}),
      task: node.task,
      verifyCommand: node.verifyCommand,
      ...(workspace !== undefined ? { workspace } : {}),
      ...(node.options?.approvalMode !== undefined ? { approvalMode: node.options.approvalMode } : {}),
      ...(node.priority !== undefined ? { priority: node.priority } : {}),
      ...(node.resources !== undefined ? { resources: [...node.resources] } : {}),
      ...((node.maxRetries ?? 0) > 0
        ? { maxRetries: node.maxRetries!, retryPolicy: { ...IMMEDIATE_RETRY_POLICY } }
        : {}),
    });
    mapping[node.id] = { loopNodeId: node.id, ...(gateId ? { approvalGateId: gateId } : {}) };
  }
  if (anyRetries) {
    warn({
      code: "retry_backoff",
      field: "nodes[].maxRetries",
      message:
        "The Loop DAG retries immediately. The Graph always schedules a retry delay, so converted nodes pin the smallest legal policy (1ms, no growth, no jitter) and still record a durable waiting_retry phase between attempts.",
    });
  }

  if (blocking.length > 0) throw new LoopDagGraphConversionError(blocking);

  const managedWorktrees = source.managedWorktrees
    ? {
        integrateDependencies:
          typeof source.managedWorktrees === "object" ? source.managedWorktrees.integrateDependencies !== false : true,
        limit: source.managedWorktreeLimit ?? 256,
      }
    : undefined;
  const definition = parseEngineeringGraphDefinition({
    graphId,
    nodes: graphNodes,
    maxConcurrency: concurrency,
    failurePolicy,
    ...(source.costBudgetUsd !== undefined ? { costBudgetUsd: source.costBudgetUsd } : {}),
    ...(source.tokenBudget !== undefined ? { tokenBudget: source.tokenBudget } : {}),
    ...(source.maxDurationMs !== undefined ? { maxDurationMs: source.maxDurationMs } : {}),
    ...(managedWorktrees ? { managedWorktrees } : {}),
    ...(source.fanIn
      ? { fanIn: { verifyCommand: source.fanIn.verifyCommand, maxIterations: source.fanIn.maxIterations ?? 1 } }
      : {}),
  });
  return { definition, nodes: mapping, warnings };
}
