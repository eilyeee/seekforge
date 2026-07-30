import { isRecord } from "../util/guards.js";
import { createHash } from "node:crypto";
import {
  graphConditionMatches,
  parseEngineeringGraphDefinition,
  type EngineeringGraphDefinition,
  type GraphNode,
} from "./graph-contract.js";
import { engineeringGraphCriticality } from "./graph-plan.js";
import type { EngineeringGraphState } from "./graph-state.js";
import { orchestrationResourcesOverlap, selectOrchestrationReadyNodes } from "./orchestration-scheduler.js";

export type EngineeringGraphNodeEstimate = {
  durationMs: number;
  costUsd?: number;
  tokens?: number;
};

export type EngineeringGraphSimulationOptions = {
  defaultDurationMs?: number;
  retryMode?: "baseline" | "worst_case";
  estimates?: Readonly<Record<string, EngineeringGraphNodeEstimate>>;
  startedAt?: Date;
};

export type EngineeringGraphSimulationNode = {
  id: string;
  kind: GraphNode["kind"];
  readyAtMs: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  resourceWaitMs: number;
  resources: string[];
  costUsd: number;
  tokens: number;
};

export type EngineeringGraphSimulationReport = {
  graphId: string;
  makespanMs: number;
  estimatedActiveDurationMs: number;
  estimatedCostUsd: number;
  estimatedTokens: number;
  criticalPath: string[];
  bottlenecks: string[];
  contingencyNodes: string[];
  risks: string[];
  nodes: EngineeringGraphSimulationNode[];
};

export type EngineeringGraphDistributionEstimate = {
  p50DurationMs: number;
  p95DurationMs: number;
  failureRate?: number;
  costUsd?: number;
  tokens?: number;
};

export type EngineeringGraphDistributionReport = {
  graphId: string;
  samples: number;
  makespanMs: { p50: number; p95: number; p99: number };
  activeDurationMs: { p50: number; p95: number; p99: number };
  durationBreachProbability: number;
  deadlineBreachProbability: number;
  budgetBreachProbability: number;
  sensitivity: Array<{ nodeId: string; uncertaintyMs: number }>;
};

export type EngineeringGraphNodeBlocker = {
  code:
    | "already_settled"
    | "already_running"
    | "dependency_pending"
    | "dependency_failed"
    | "condition_false"
    | "route_mismatch"
    | "approval_required"
    | "signal_pending"
    | "timer_pending"
    | "wait_expired"
    | "deadline_expired"
    | "concurrency_full"
    | "resource_busy"
    | "cost_budget_exhausted"
    | "token_budget_exhausted"
    | "duration_budget_exhausted";
  message: string;
  relatedNodeIds?: string[];
};

export type EngineeringGraphNodeExplanation = {
  graphId: string;
  nodeId: string;
  status: "pending" | "running" | "settled";
  eligible: boolean;
  blockers: EngineeringGraphNodeBlocker[];
  dependencies: Array<{ nodeId: string; status: "pending" | EngineeringGraphState["results"][number]["status"] }>;
  resources: string[];
  remainingBudget: { costUsd?: number; tokens?: number; durationMs?: number };
};

export type EngineeringGraphNodeExplanationContext = {
  signalAvailable?: boolean;
};

function distributionQuantile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))]!;
}

function deterministicRandom(seed: string): () => number {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function sampledDuration(estimate: EngineeringGraphDistributionEstimate, random: () => number): number {
  const p50 = Math.max(1, Math.round(estimate.p50DurationMs));
  const p95 = Math.max(p50, Math.round(estimate.p95DurationMs));
  const draw = random();
  if (draw <= 0.5) return Math.max(1, Math.round(p50 * (0.5 + draw)));
  if (draw <= 0.95) return Math.round(p50 + ((draw - 0.5) / 0.45) * (p95 - p50));
  return Math.min(604_800_000, Math.round(p95 * (1 + (draw - 0.95) * 10)));
}

/** Runs a bounded deterministic Monte Carlo forecast from measured node distributions. */
export function simulateEngineeringGraphDistribution(
  input: unknown,
  estimatesInput: Readonly<Record<string, EngineeringGraphDistributionEstimate>>,
  options: { samples?: number; seed?: string; startedAt?: Date } = {},
): EngineeringGraphDistributionReport {
  const definition = parseEngineeringGraphDefinition(input);
  const samples = options.samples ?? 128;
  if (!Number.isSafeInteger(samples) || samples < 16 || samples > 512) {
    throw new RangeError("Graph distribution samples must be an integer from 16 to 512");
  }
  if (!isRecord(estimatesInput) || Object.keys(estimatesInput).length > definition.nodes.length) {
    throw new Error("Graph distribution estimates are invalid");
  }
  const known = new Set(definition.nodes.map((node) => node.id));
  const estimates = new Map<string, EngineeringGraphDistributionEstimate>();
  for (const [nodeId, estimate] of Object.entries(estimatesInput)) {
    if (
      !known.has(nodeId) ||
      !isRecord(estimate) ||
      Object.keys(estimate).some(
        (key) => !["p50DurationMs", "p95DurationMs", "failureRate", "costUsd", "tokens"].includes(key),
      ) ||
      !Number.isSafeInteger(estimate.p50DurationMs) ||
      (estimate.p50DurationMs as number) < 0 ||
      !Number.isSafeInteger(estimate.p95DurationMs) ||
      (estimate.p95DurationMs as number) < (estimate.p50DurationMs as number) ||
      (estimate.failureRate !== undefined &&
        (typeof estimate.failureRate !== "number" ||
          !Number.isFinite(estimate.failureRate) ||
          estimate.failureRate < 0 ||
          estimate.failureRate > 1)) ||
      (estimate.costUsd !== undefined &&
        (typeof estimate.costUsd !== "number" || !Number.isFinite(estimate.costUsd) || estimate.costUsd < 0)) ||
      (estimate.tokens !== undefined && (!Number.isSafeInteger(estimate.tokens) || (estimate.tokens as number) < 0))
    ) {
      throw new Error(`Graph distribution estimate is invalid: ${nodeId}`);
    }
    estimates.set(nodeId, estimate as EngineeringGraphDistributionEstimate);
  }
  const random = deterministicRandom(`${definition.graphId}\0${options.seed ?? "default"}\0${samples}`);
  const makespans: number[] = [];
  const activeDurations: number[] = [];
  const startedAtMs = (options.startedAt ?? new Date()).getTime();
  if (!Number.isFinite(startedAtMs)) throw new Error("Graph distribution start time is invalid");
  let durationBreaches = 0;
  let deadlineBreaches = 0;
  let budgetBreaches = 0;
  for (let sample = 0; sample < samples; sample++) {
    const sampled: Record<string, EngineeringGraphNodeEstimate> = {};
    for (const node of definition.nodes) {
      const estimate = estimates.get(node.id);
      if (!estimate) continue;
      const failed = estimate.failureRate !== undefined && random() < estimate.failureRate;
      const attempts = failed ? Math.max(1, (node.maxRetries ?? 0) + 1) : 1;
      sampled[node.id] = {
        durationMs: Math.min(604_800_000, sampledDuration(estimate, random) * attempts),
        ...(estimate.costUsd !== undefined ? { costUsd: estimate.costUsd * attempts } : {}),
        ...(estimate.tokens !== undefined ? { tokens: estimate.tokens * attempts } : {}),
      };
    }
    const report = simulateEngineeringGraph(definition, {
      estimates: sampled,
      ...(options.startedAt ? { startedAt: options.startedAt } : {}),
    });
    makespans.push(report.makespanMs);
    activeDurations.push(report.estimatedActiveDurationMs);
    if (definition.maxDurationMs !== undefined && report.estimatedActiveDurationMs > definition.maxDurationMs) {
      durationBreaches++;
    }
    if (
      report.nodes.some((result) => {
        const node = definition.nodes.find((candidate) => candidate.id === result.id);
        const deadlines = [node?.deadlineAt, node?.kind === "wait" ? node.waitFor?.expiresAt : undefined];
        return deadlines.some(
          (deadline) => deadline !== undefined && startedAtMs + result.startMs >= Date.parse(deadline),
        );
      })
    ) {
      deadlineBreaches++;
    }
    if (
      (definition.costBudgetUsd !== undefined && report.estimatedCostUsd > definition.costBudgetUsd) ||
      (definition.tokenBudget !== undefined && report.estimatedTokens > definition.tokenBudget)
    ) {
      budgetBreaches++;
    }
  }
  return {
    graphId: definition.graphId,
    samples,
    makespanMs: {
      p50: distributionQuantile(makespans, 0.5),
      p95: distributionQuantile(makespans, 0.95),
      p99: distributionQuantile(makespans, 0.99),
    },
    activeDurationMs: {
      p50: distributionQuantile(activeDurations, 0.5),
      p95: distributionQuantile(activeDurations, 0.95),
      p99: distributionQuantile(activeDurations, 0.99),
    },
    durationBreachProbability: durationBreaches / samples,
    deadlineBreachProbability: deadlineBreaches / samples,
    budgetBreachProbability: budgetBreaches / samples,
    sensitivity: [...estimates]
      .map(([nodeId, estimate]) => ({ nodeId, uncertaintyMs: estimate.p95DurationMs - estimate.p50DurationMs }))
      .sort((left, right) => right.uncertaintyMs - left.uncertaintyMs || left.nodeId.localeCompare(right.nodeId))
      .slice(0, 8),
  };
}

function positiveSafeInteger(value: unknown, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new RangeError(`${label} must be an integer from 1 to ${max}`);
  }
  return value as number;
}

function normalizedEstimates(
  definition: EngineeringGraphDefinition,
  options: EngineeringGraphSimulationOptions,
): ReadonlyMap<string, EngineeringGraphNodeEstimate> {
  if (options.estimates !== undefined && !isRecord(options.estimates)) {
    throw new Error("Graph simulation estimates must be an object");
  }
  const known = new Set(definition.nodes.map((node) => node.id));
  const entries = Object.entries(options.estimates ?? {});
  if (entries.length > definition.nodes.length) throw new Error("Graph simulation has too many estimates");
  const result = new Map<string, EngineeringGraphNodeEstimate>();
  for (const [nodeId, estimate] of entries) {
    if (
      !known.has(nodeId) ||
      !isRecord(estimate) ||
      Object.keys(estimate).some((key) => key !== "durationMs" && key !== "costUsd" && key !== "tokens")
    ) {
      throw new Error(`Graph simulation estimate is invalid: ${nodeId}`);
    }
    const durationMs = positiveSafeInteger(estimate.durationMs, `Graph simulation duration for ${nodeId}`, 604_800_000);
    if (
      (estimate.costUsd !== undefined &&
        (typeof estimate.costUsd !== "number" || !Number.isFinite(estimate.costUsd) || estimate.costUsd < 0)) ||
      (estimate.tokens !== undefined && (!Number.isSafeInteger(estimate.tokens) || (estimate.tokens as number) < 0))
    ) {
      throw new Error(`Graph simulation usage estimate is invalid: ${nodeId}`);
    }
    result.set(nodeId, {
      durationMs,
      ...(typeof estimate.costUsd === "number" ? { costUsd: estimate.costUsd } : {}),
      ...(typeof estimate.tokens === "number" ? { tokens: estimate.tokens } : {}),
    });
  }
  return result;
}

function nodeDuration(
  node: GraphNode,
  estimate: EngineeringGraphNodeEstimate | undefined,
  defaultDurationMs: number,
  retryMode: EngineeringGraphSimulationOptions["retryMode"],
): number {
  if (node.kind === "gate") return 0;
  if (node.kind === "wait") return 0;
  const mapWaves =
    node.kind === "map" && estimate === undefined ? Math.ceil((node.maxItems ?? 32) / (node.mapConcurrency ?? 4)) : 1;
  const attempts = retryMode === "worst_case" ? (node.maxRetries ?? 0) + 1 : 1;
  return (estimate?.durationMs ?? defaultDurationMs * mapWaves) * attempts;
}

function nodeAttempts(node: GraphNode, retryMode: EngineeringGraphSimulationOptions["retryMode"]): number {
  if (node.kind === "gate" || node.kind === "wait") return 1;
  return retryMode === "worst_case" ? (node.maxRetries ?? 0) + 1 : 1;
}

/** Produces a pure, resource-aware forecast without acquiring leases or creating runtime state. */
export function simulateEngineeringGraph(
  input: unknown,
  options: EngineeringGraphSimulationOptions = {},
): EngineeringGraphSimulationReport {
  const definition = parseEngineeringGraphDefinition(input);
  const defaultDurationMs =
    options.defaultDurationMs === undefined
      ? 1_000
      : positiveSafeInteger(options.defaultDurationMs, "Graph simulation defaultDurationMs", 86_400_000);
  if (options.retryMode !== undefined && options.retryMode !== "baseline" && options.retryMode !== "worst_case") {
    throw new Error("Graph simulation retryMode must be baseline or worst_case");
  }
  if (options.startedAt !== undefined && !(options.startedAt instanceof Date)) {
    throw new Error("Graph simulation startedAt must be a Date");
  }
  const startedAt = options.startedAt ?? new Date();
  const startedAtMs = startedAt.getTime();
  if (!Number.isFinite(startedAtMs)) throw new Error("Graph simulation startedAt is invalid");
  const estimates = normalizedEstimates(definition, options);
  const criticality = engineeringGraphCriticality(definition);
  const primary = definition.nodes.filter((node) => node.kind !== "compensation");
  const remaining = new Map(primary.map((node) => [node.id, node]));
  const completed = new Map<string, EngineeringGraphSimulationNode>();
  const running = new Map<string, EngineeringGraphSimulationNode>();
  const accumulatedResourceWait = new Map<string, number>();
  let now = 0;

  while (remaining.size > 0 || running.size > 0) {
    const availableSlots = (definition.maxConcurrency ?? 1) - running.size;
    const ready = [...remaining.values()].filter((node) =>
      (node.dependsOn ?? []).every((dependency) => completed.has(dependency)),
    );
    const blockingWait = ready.find(
      (node) =>
        node.kind === "wait" &&
        node.waitFor?.notBefore !== undefined &&
        Date.parse(node.waitFor.notBefore) - startedAtMs > now,
    );
    if (blockingWait) {
      if (running.size > 0) {
        now = Math.max(...[...running.values()].map((node) => node.endMs));
        for (const [nodeId, node] of running) completed.set(nodeId, node);
        running.clear();
      } else now = Date.parse(blockingWait.waitFor!.notBefore!) - startedAtMs;
      continue;
    }
    const temporallyReady = ready.filter((node) => {
      const notBefore = node.waitFor?.notBefore ? Date.parse(node.waitFor.notBefore) - startedAtMs : 0;
      return !Number.isFinite(notBefore) || notBefore <= now;
    });
    const selected = selectOrchestrationReadyNodes(
      temporallyReady.map((node) => ({
        id: node.id,
        priority: node.priority,
        score: criticality.get(node.id),
        resources: node.resources,
      })),
      [...running.values()].map((node) => ({ resources: node.resources })),
      Math.max(0, availableSlots),
      definition.resourceCapacities,
    );
    const selectedWithoutResourceLimits = selectOrchestrationReadyNodes(
      temporallyReady.map((node) => ({ id: node.id, priority: node.priority, score: criticality.get(node.id) })),
      [],
      Math.max(0, availableSlots),
    );
    const resourceBlocked = selectedWithoutResourceLimits.filter(
      (nodeId) => !selected.includes(nodeId) && (remaining.get(nodeId)?.resources?.length ?? 0) > 0,
    );
    const advanceTo = (next: number): void => {
      const delta = Math.max(0, next - now);
      for (const nodeId of resourceBlocked) {
        accumulatedResourceWait.set(nodeId, (accumulatedResourceWait.get(nodeId) ?? 0) + delta);
      }
      now = next;
    };
    for (const nodeId of selected) {
      const node = remaining.get(nodeId)!;
      const dependencyReadyAtMs = Math.max(0, ...(node.dependsOn ?? []).map((id) => completed.get(id)?.endMs ?? 0));
      const timerReadyAtMs = node.waitFor?.notBefore
        ? Math.max(0, Date.parse(node.waitFor.notBefore) - startedAtMs)
        : 0;
      const readyAtMs = Math.max(dependencyReadyAtMs, timerReadyAtMs);
      const estimate = estimates.get(node.id);
      const durationMs = nodeDuration(node, estimate, defaultDurationMs, options.retryMode ?? "baseline");
      const attempts = nodeAttempts(node, options.retryMode ?? "baseline");
      const item: EngineeringGraphSimulationNode = {
        id: node.id,
        kind: node.kind,
        readyAtMs,
        startMs: now,
        endMs: now + durationMs,
        durationMs,
        resourceWaitMs: accumulatedResourceWait.get(node.id) ?? 0,
        resources: [...(node.resources ?? [])],
        costUsd: (estimate?.costUsd ?? 0) * attempts,
        tokens: (estimate?.tokens ?? 0) * attempts,
      };
      remaining.delete(nodeId);
      running.set(nodeId, item);
    }
    if (running.size === 0) {
      const nextTimer = ready
        .flatMap((node) => (node.waitFor?.notBefore ? [Date.parse(node.waitFor.notBefore) - startedAtMs] : []))
        .filter((value) => Number.isFinite(value) && value > now)
        .sort((left, right) => left - right)[0];
      if (nextTimer !== undefined) {
        advanceTo(nextTimer);
        continue;
      }
      throw new Error("Graph simulation could not schedule the remaining nodes");
    }
    const nextCompletion = Math.min(...[...running.values()].map((node) => node.endMs));
    const nextTimer = ready
      .flatMap((node) => (node.waitFor?.notBefore ? [Date.parse(node.waitFor.notBefore) - startedAtMs] : []))
      .filter((value) => Number.isFinite(value) && value > now)
      .sort((left, right) => left - right)[0];
    if (nextTimer !== undefined && nextTimer < nextCompletion) {
      advanceTo(nextTimer);
      continue;
    }
    advanceTo(nextCompletion);
    for (const [nodeId, node] of [...running]) {
      if (node.endMs === nextCompletion) {
        running.delete(nodeId);
        completed.set(nodeId, node);
      }
    }
  }

  const nodes = primary.flatMap((node) => {
    const result = completed.get(node.id);
    return result ? [result] : [];
  });
  const makespanMs = Math.max(0, ...nodes.map((node) => node.endMs));
  const activeIntervals = nodes
    .filter((node) => node.kind !== "wait" && node.endMs > node.startMs)
    .map((node) => [node.startMs, node.endMs] as const)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let estimatedActiveDurationMs = 0;
  let activeStart: number | undefined;
  let activeEnd: number | undefined;
  for (const [start, end] of activeIntervals) {
    if (activeStart === undefined || activeEnd === undefined) {
      activeStart = start;
      activeEnd = end;
    } else if (start > activeEnd) {
      estimatedActiveDurationMs += activeEnd - activeStart;
      activeStart = start;
      activeEnd = end;
    } else activeEnd = Math.max(activeEnd, end);
  }
  if (activeStart !== undefined && activeEnd !== undefined) estimatedActiveDurationMs += activeEnd - activeStart;
  const longestPaths = new Map<string, { duration: number; path: string[] }>();
  // Map insertion order is the scheduler's topological settlement order, even
  // when zero-duration parent and child nodes share an end timestamp.
  for (const node of completed.values()) {
    const definitionNode = definition.nodes.find((candidate) => candidate.id === node.id)!;
    const parent = (definitionNode.dependsOn ?? [])
      .map((dependency) => longestPaths.get(dependency))
      .filter((value): value is { duration: number; path: string[] } => value !== undefined)
      .sort((left, right) => right.duration - left.duration)[0];
    longestPaths.set(node.id, {
      duration: (parent?.duration ?? 0) + node.durationMs,
      path: [...(parent?.path ?? []), node.id],
    });
  }
  const criticalPath =
    [...longestPaths.values()].sort(
      (left, right) => right.duration - left.duration || right.path.length - left.path.length,
    )[0]?.path ?? [];
  const estimatedCostUsd = nodes.reduce((sum, node) => sum + node.costUsd, 0);
  const estimatedTokens = nodes.reduce((sum, node) => sum + node.tokens, 0);
  const risks: string[] = [];
  if (definition.maxDurationMs !== undefined && estimatedActiveDurationMs > definition.maxDurationMs) {
    risks.push(
      `Estimated active duration exceeds maxDurationMs by ${estimatedActiveDurationMs - definition.maxDurationMs}ms`,
    );
  }
  if (definition.costBudgetUsd !== undefined && estimatedCostUsd > definition.costBudgetUsd) {
    risks.push(`Estimated cost exceeds costBudgetUsd by $${(estimatedCostUsd - definition.costBudgetUsd).toFixed(4)}`);
  }
  if (definition.tokenBudget !== undefined && estimatedTokens > definition.tokenBudget) {
    risks.push(`Estimated tokens exceed tokenBudget by ${estimatedTokens - definition.tokenBudget}`);
  }
  for (const node of definition.nodes) {
    const simulated = completed.get(node.id);
    if (simulated && node.deadlineAt && startedAtMs + simulated.startMs >= Date.parse(node.deadlineAt)) {
      risks.push(`Node ${node.id} is estimated to miss its start deadline`);
    }
    if (node.kind === "gate") risks.push(`Node ${node.id} requires a runtime approval decision`);
    if (node.kind === "wait" && node.waitFor?.signal) risks.push(`Node ${node.id} depends on an external signal`);
    if (
      node.kind === "wait" &&
      node.waitFor?.expiresAt &&
      simulated &&
      startedAtMs + simulated.startMs >= Date.parse(node.waitFor.expiresAt)
    ) {
      risks.push(`Node ${node.id} may expire before it can resolve`);
    }
    if (node.condition || node.route) risks.push(`Node ${node.id} belongs to a runtime-selected conditional path`);
  }
  const bottlenecks = nodes
    .filter((node) => node.resourceWaitMs > 0)
    .sort((left, right) => right.resourceWaitMs - left.resourceWaitMs || left.id.localeCompare(right.id))
    .slice(0, 8)
    .map((node) => node.id);
  return {
    graphId: definition.graphId,
    makespanMs,
    estimatedActiveDurationMs,
    estimatedCostUsd,
    estimatedTokens,
    criticalPath,
    bottlenecks,
    contingencyNodes: definition.nodes.filter((node) => node.kind === "compensation").map((node) => node.id),
    risks,
    nodes,
  };
}

/** Explains the current eligibility decision from a validated checkpoint snapshot. */
export function explainEngineeringGraphNode(
  definitionInput: unknown,
  state: EngineeringGraphState | undefined,
  nodeId: string,
  now = new Date(),
  context: EngineeringGraphNodeExplanationContext = {},
): EngineeringGraphNodeExplanation {
  const definition = parseEngineeringGraphDefinition(definitionInput);
  const node = definition.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Unknown Graph node: ${nodeId}`);
  if (state && (state.graphId !== definition.graphId || state.definition.graphId !== definition.graphId)) {
    throw new Error("Graph explanation state does not match the definition");
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Graph explanation time is invalid");
  const resultById = new Map((state?.results ?? []).map((result) => [result.id, result]));
  const blockers: EngineeringGraphNodeBlocker[] = [];
  const settled = resultById.get(node.id);
  const active = state?.activeAttempts.find((attempt) => attempt.nodeId === node.id);
  if (settled) blockers.push({ code: "already_settled", message: `Node already settled as ${settled.status}` });
  if (active) blockers.push({ code: "already_running", message: `Node attempt ${active.attempt} is active` });
  const dependencies = (node.dependsOn ?? []).map((dependency) => ({
    nodeId: dependency,
    status: resultById.get(dependency)?.status ?? ("pending" as const),
  }));
  const pendingDependencies = dependencies
    .filter((dependency) => dependency.status === "pending")
    .map((item) => item.nodeId);
  if (pendingDependencies.length > 0) {
    blockers.push({
      code: "dependency_pending",
      message: "Dependencies have not settled",
      relatedNodeIds: pendingDependencies,
    });
  } else if (
    node.kind !== "join" &&
    !node.condition &&
    dependencies.some((dependency) => dependency.status !== "passed")
  ) {
    blockers.push({
      code: "dependency_failed",
      message: "A dependency did not pass",
      relatedNodeIds: dependencies.filter((dependency) => dependency.status !== "passed").map((item) => item.nodeId),
    });
  }
  if (
    !settled &&
    pendingDependencies.length === 0 &&
    node.condition &&
    !graphConditionMatches(node.condition, resultById)
  ) {
    blockers.push({ code: "condition_false", message: "The node condition does not match current results" });
  }
  if (!settled && pendingDependencies.length === 0 && node.route) {
    const router = resultById.get(node.route.routerId);
    const branch = isRecord(router?.output) ? router.output.branch : undefined;
    if (router?.status !== "passed" || branch !== node.route.branch) {
      blockers.push({ code: "route_mismatch", message: `Router did not select branch ${node.route.branch}` });
    }
  }
  if (!settled && node.kind === "gate")
    blockers.push({ code: "approval_required", message: "Gate approval is required" });
  if (!settled && node.kind === "wait") {
    const timerPending = node.waitFor?.notBefore !== undefined && nowMs < Date.parse(node.waitFor.notBefore);
    const timerReady = node.waitFor?.notBefore !== undefined && !timerPending;
    const signalReady = node.waitFor?.signal !== undefined && context.signalAvailable === true;
    const expired = node.waitFor?.expiresAt !== undefined && nowMs >= Date.parse(node.waitFor.expiresAt);
    if (expired && !timerReady && !signalReady) {
      blockers.push({ code: "wait_expired", message: `Wait expired at ${node.waitFor?.expiresAt}` });
    } else if (timerPending && !signalReady) {
      blockers.push({ code: "timer_pending", message: `Timer is pending until ${node.waitFor?.notBefore}` });
    }
    if (!expired && node.waitFor?.signal && !signalReady && !timerReady)
      blockers.push({ code: "signal_pending", message: `Signal ${node.waitFor.signal} is required` });
  }
  if (!settled && node.deadlineAt && nowMs >= Date.parse(node.deadlineAt)) {
    blockers.push({ code: "deadline_expired", message: `Start deadline expired at ${node.deadlineAt}` });
  }
  const activeNodes = (state?.activeAttempts ?? []).flatMap((attempt) => {
    const candidate = definition.nodes.find((item) => item.id === attempt.nodeId);
    return candidate ? [candidate] : [];
  });
  if (!settled && !active && activeNodes.length >= (definition.maxConcurrency ?? 1)) {
    blockers.push({ code: "concurrency_full", message: "Graph concurrency is fully reserved" });
  }
  if (!settled && !active && node.resources?.length) {
    const conflicts = activeNodes.filter((candidate) =>
      (candidate.resources ?? []).some((reserved) =>
        node.resources!.some((requested) => orchestrationResourcesOverlap(requested, reserved)),
      ),
    );
    const selected = selectOrchestrationReadyNodes(
      [{ id: node.id, resources: node.resources }],
      activeNodes.map((candidate) => ({ resources: candidate.resources })),
      1,
      definition.resourceCapacities,
    );
    if (selected.length === 0) {
      blockers.push({
        code: "resource_busy",
        message: "A required resource is fully reserved",
        ...(conflicts.length ? { relatedNodeIds: conflicts.map((candidate) => candidate.id) } : {}),
      });
    }
  }
  const remainingBudget = {
    ...(definition.costBudgetUsd !== undefined
      ? { costUsd: Math.max(0, definition.costBudgetUsd - (state?.spentCost ?? 0)) }
      : {}),
    ...(definition.tokenBudget !== undefined
      ? { tokens: Math.max(0, definition.tokenBudget - (state?.spentTokens ?? 0)) }
      : {}),
    ...(definition.maxDurationMs !== undefined
      ? { durationMs: Math.max(0, definition.maxDurationMs - (state?.elapsedMs ?? 0)) }
      : {}),
  };
  if (remainingBudget.costUsd === 0)
    blockers.push({ code: "cost_budget_exhausted", message: "Cost budget is exhausted" });
  if (remainingBudget.tokens === 0)
    blockers.push({ code: "token_budget_exhausted", message: "Token budget is exhausted" });
  if (remainingBudget.durationMs === 0) {
    blockers.push({ code: "duration_budget_exhausted", message: "Duration budget is exhausted" });
  }
  return {
    graphId: definition.graphId,
    nodeId,
    status: settled ? "settled" : active ? "running" : "pending",
    eligible: blockers.length === 0,
    blockers,
    dependencies,
    resources: [...(node.resources ?? [])],
    remainingBudget,
  };
}
