import {
  applyEngineeringGraphExpansion,
  applyEngineeringGraphTreeMigration,
  analyzeGraphSchedulingIntelligence,
  buildEngineeringGraphEvidenceReport,
  buildEngineeringGraphHealthReport,
  checkGraphControlTarget,
  checkGraphSignalTarget,
  compareEngineeringGraphRuns,
  compareEngineeringGraphTemplates,
  deprecateEngineeringGraphTemplate,
  enqueueGraphControl,
  enqueueEngineeringGraphSignal,
  graphHandlersWithPlugins,
  archiveEngineeringGraphResources,
  clearEngineeringGraphRecovery,
  diagnoseEngineeringGraphCheckpoint,
  engineeringGraphStateExists,
  engineeringGraphNeedsAgentRuntime,
  engineeringGraphSignalAvailable,
  explainEngineeringGraphNode,
  inspectEngineeringGraphResources,
  inspectEngineeringGraphArtifactStore,
  isSessionRunActive,
  isValidLoopDagId,
  listEngineeringGraphStates,
  listEngineeringGraphTemplates,
  loadPluginContributions,
  loadEngineeringGraphState,
  parseEngineeringGraphTemplate,
  readEngineeringGraphHistory,
  readEngineeringGraphRunSnapshots,
  registerEngineeringGraphTemplate,
  resolveEngineeringGraphTemplate,
  materializeEngineeringGraph,
  materializeEngineeringGraphArtifact,
  planEngineeringGraph,
  planEngineeringGraphExpansion,
  planEngineeringGraphMigration,
  planEngineeringGraphTreeMigration,
  listEngineeringGraphTreeStates,
  promoteEngineeringGraphResult,
  pruneEngineeringGraphResources,
  pruneEngineeringGraphArtifactStore,
  readGraphSchedulingObservations,
  readFileIfExists,
  removeEngineeringGraphState,
  setEngineeringGraphPriority,
  simulateEngineeringGraph,
  summarizeGraphSchedulingIntelligence,
  runEngineeringGraph,
  validateEngineeringGraphRunOptions,
  validateEngineeringGraphWorkspaces,
  verifyEngineeringGraphEvidenceIntegrity,
  type DurableGraphControlCommand,
  type EngineeringGraphDefinition,
  type EngineeringGraphState,
  type GraphEvent,
  type EngineeringGraphTemplate,
  type AgentCoreDeps,
} from "@seekforge/core";
import { resolve } from "node:path";
import { fail } from "../colors.js";
import { loadConfig } from "../config.js";
import { loadGraphExecutionRegistry } from "../graph-executors.js";
import { withAgentRuntime } from "../loop-runtime.js";
import { ensureWorkspaceAuthorized } from "./run.js";

export type GraphRunCliOptions = {
  resume?: boolean;
  restart?: boolean;
  rerun?: string[];
  approve?: string[];
  yes?: boolean;
  model?: string;
  profile?: string;
  params?: string[];
};

function graphParameters(values: readonly string[] = []): Record<string, unknown> {
  const result = Object.create(null) as Record<string, unknown>;
  for (const item of values) {
    const separator = item.indexOf("=");
    if (separator < 1) throw new Error(`Graph parameter must use name=value: ${item}`);
    const name = item.slice(0, separator);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) || Object.hasOwn(result, name)) {
      throw new Error(`Graph parameter name is invalid or duplicated: ${name}`);
    }
    const raw = item.slice(separator + 1);
    result[name] =
      raw === "true"
        ? true
        : raw === "false"
          ? false
          : /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(raw) && Number.isFinite(Number(raw))
            ? Number(raw)
            : raw;
  }
  return result;
}

export function readEngineeringGraphFile(
  file: string,
  workspace = process.cwd(),
  params: readonly string[] = [],
): EngineeringGraphDefinition {
  const raw = readFileIfExists(resolve(workspace, file), 512 * 1024);
  if (raw === undefined) throw new Error(`Engineering Graph file not found: ${file}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Engineering Graph file is not valid JSON: ${file}`);
  }
  return materializeEngineeringGraph(parsed, graphParameters(params));
}

export async function graphValidateCommand(
  file: string,
  opts: { params?: string[]; json?: boolean } = {},
): Promise<void> {
  try {
    const graph = readEngineeringGraphFile(file, process.cwd(), opts.params);
    console.log(
      opts.json
        ? JSON.stringify(planEngineeringGraph(graph), null, 2)
        : `${graph.graphId}\tvalid\t${graph.nodes.length} node(s)`,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function graphRunCommand(file: string, opts: GraphRunCliOptions): Promise<void> {
  const workspace = process.cwd();
  let graphHandlers: ReturnType<typeof graphHandlersWithPlugins>;
  let graphExecutors: ReturnType<typeof loadGraphExecutionRegistry>;
  let graph: EngineeringGraphDefinition;
  try {
    graphHandlers = graphHandlersWithPlugins(loadPluginContributions(workspace));
    // Trusted `remote` adapters come from the operator's home registration file
    // only; see graph-executors.ts for why nothing in the repository may grant
    // this. Reading it is pure, so it stays in the validation phase.
    graphExecutors = loadGraphExecutionRegistry(workspace);
    graph = readEngineeringGraphFile(file, workspace, opts.params);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  const needsRuntime = engineeringGraphNeedsAgentRuntime(graph);
  try {
    validateEngineeringGraphRunOptions(graph, {
      workspace,
      handlers: graphHandlers,
      executors: graphExecutors,
      ...(opts.resume ? { resume: true } : {}),
      ...(opts.restart ? { restart: true } : {}),
      ...(opts.rerun?.length ? { rerunFrom: opts.rerun } : {}),
      ...(opts.approve?.length ? { approvedNodeIds: opts.approve } : {}),
    });
    validateEngineeringGraphWorkspaces(graph, workspace);
    if (!opts.resume && !opts.restart && engineeringGraphStateExists(workspace, graph.graphId)) {
      throw new Error(`Persisted Graph already exists; use resume or restart: ${graph.graphId}`);
    }
    if (opts.resume && !loadEngineeringGraphState(workspace, graph.graphId)) {
      throw new Error(`Persisted Graph not found or invalid: ${graph.graphId}`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(workspace, undefined, opts.profile);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  const model = opts.model ?? config.model;
  if (needsRuntime && model === "deepseek-reasoner") {
    fail("deepseek-reasoner cannot execute tools in an Engineering Graph");
    process.exitCode = 1;
    return;
  }
  if (needsRuntime && !config.apiKey) {
    fail("API key is not configured");
    process.exitCode = 1;
    return;
  }
  if (!(await ensureWorkspaceAuthorized(workspace, { yes: opts.yes === true, machine: false }))) return;
  const execute = async (deps: AgentCoreDeps, signal?: AbortSignal): Promise<void> => {
    let state = await runEngineeringGraph(deps, graph, {
      workspace,
      handlers: graphHandlers,
      executors: graphExecutors,
      ...(signal ? { signal } : {}),
      ...(opts.resume ? { resume: true } : {}),
      ...(opts.restart ? { restart: true } : {}),
      ...(opts.rerun?.length ? { rerunFrom: opts.rerun } : {}),
      ...(opts.approve?.length ? { approvedNodeIds: opts.approve } : {}),
      onEvent: (event) => console.log(formatGraphEvent(event)),
    });
    if (state.recovery || state.recoveryAttemptId) {
      state = clearEngineeringGraphRecovery(workspace, state.graphId, state.controlRunId);
    }
    console.log(
      `Graph ${state.graphId}: ${state.status} · $${state.spentCost.toFixed(4)} · ${state.spentTokens} tokens`,
    );
    if (state.status !== "passed" && state.status !== "paused") process.exitCode = 1;
    if (state.status === "paused") process.exitCode = 2;
  };
  try {
    if (needsRuntime) {
      await withAgentRuntime(
        { config, workspace, model, extractMemory: true, forceOnSecondSigint: true },
        ({ deps, controller }) => execute(deps, controller.signal),
      );
    } else await execute({} as AgentCoreDeps);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

/**
 * One progress line for a streamed Graph event.
 *
 * `message` carries the ENTIRE content of `graph.warning` and the failure detail
 * of `node.attempt.settled`, so the earlier type-only line told a watching
 * operator that something had happened and nothing about what.
 */
export function formatGraphEvent(event: GraphEvent): string {
  const node = event.nodeId ? ` ${event.nodeId}` : "";
  const status = event.status ? ` ${event.status}` : "";
  const message = event.message ? ` — ${event.message}` : "";
  return `[${event.sequence}] ${event.type}${node}${status}${message}`;
}

export function graphListCommand(): void {
  console.log(
    listEngineeringGraphStates(process.cwd())
      .map(
        (state) =>
          `${state.graphId}\t${state.status}\t${state.results.length}\tpriority=${state.priority}\t${state.updatedAt}`,
      )
      .join("\n"),
  );
}

export function graphIntelligenceCommand(graphId?: string): void {
  try {
    if (graphId !== undefined && !isValidLoopDagId(graphId)) throw new Error(`Invalid Graph id: ${graphId}`);
    const observations = readGraphSchedulingObservations(process.cwd()).filter(
      (observation) => graphId === undefined || observation.graphId === graphId,
    );
    const entries = summarizeGraphSchedulingIntelligence(observations);
    console.log(JSON.stringify({ entries, findings: analyzeGraphSchedulingIntelligence(entries) }, null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function graphHealthCommand(graphId: string): void {
  try {
    if (!isValidLoopDagId(graphId)) throw new Error(`Invalid Graph id: ${graphId}`);
    const state = loadEngineeringGraphState(process.cwd(), graphId);
    if (!state) throw new Error(`Persisted Graph not found or invalid: ${graphId}`);
    console.log(
      JSON.stringify(buildEngineeringGraphHealthReport(state, readGraphSchedulingObservations(process.cwd())), null, 2),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function graphPriorityCommand(graphId: string, priority: number): void {
  try {
    const state = setEngineeringGraphPriority(process.cwd(), graphId, priority);
    console.log(`Updated Graph priority: ${state.graphId}\t${state.priority}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function graphShowCommand(graphId: string, historyOnly = false): void {
  const state = loadEngineeringGraphState(process.cwd(), graphId);
  if (!state) {
    fail(`Persisted Engineering Graph not found or invalid: ${graphId}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(historyOnly ? state.events : state, null, 2));
}

export function graphDiagnoseCommand(graphId: string): void {
  try {
    const workspace = process.cwd();
    const state = loadEngineeringGraphState(workspace, graphId);
    if (!state) throw new Error(`Persisted Engineering Graph not found or invalid: ${graphId}`);
    const report = diagnoseEngineeringGraphCheckpoint(
      state,
      readEngineeringGraphHistory(workspace, graphId, { limit: 2_000, tail: true }),
    );
    console.log(JSON.stringify(report, null, 2));
    if (!report.healthy) process.exitCode = 1;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function graphMigrationPlanCommand(file: string, params: readonly string[] = []): void {
  try {
    const workspace = process.cwd();
    const definition = readEngineeringGraphFile(file, workspace, params);
    const state = loadEngineeringGraphState(workspace, definition.graphId);
    if (!state) throw new Error(`Persisted Engineering Graph not found or invalid: ${definition.graphId}`);
    console.log(
      JSON.stringify(
        {
          ...planEngineeringGraphMigration(state.definition, definition),
          tree: planEngineeringGraphTreeMigration(
            state.definition,
            definition,
            listEngineeringGraphTreeStates(workspace, [state.definition, definition]),
          ),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function graphExpansionPlanCommand(file: string, params: readonly string[] = []): void {
  try {
    const workspace = process.cwd();
    const definition = readEngineeringGraphFile(file, workspace, params);
    const state = loadEngineeringGraphState(workspace, definition.graphId);
    if (!state) throw new Error(`Persisted Engineering Graph not found or invalid: ${definition.graphId}`);
    console.log(JSON.stringify(planEngineeringGraphExpansion(state.definition, definition), null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function graphMigrateCommand(file: string, params: readonly string[] = []): void {
  try {
    const workspace = process.cwd();
    const definition = readEngineeringGraphFile(file, workspace, params);
    validateEngineeringGraphRunOptions(definition, {
      workspace,
      handlers: graphHandlersWithPlugins(loadPluginContributions(workspace)),
      executors: loadGraphExecutionRegistry(workspace),
    });
    console.log(JSON.stringify(applyEngineeringGraphTreeMigration(workspace, definition), null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function graphExpandCommand(file: string, params: readonly string[] = []): void {
  try {
    const workspace = process.cwd();
    const definition = readEngineeringGraphFile(file, workspace, params);
    validateEngineeringGraphRunOptions(definition, {
      workspace,
      handlers: graphHandlersWithPlugins(loadPluginContributions(workspace)),
      executors: loadGraphExecutionRegistry(workspace),
    });
    console.log(JSON.stringify(applyEngineeringGraphExpansion(workspace, definition), null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function graphArtifactMaterializeCommand(
  sha256: string,
  sizeBytes: number,
  target: string,
  overwrite = false,
): void {
  try {
    console.log(
      JSON.stringify(
        materializeEngineeringGraphArtifact(process.cwd(), sha256, sizeBytes, target, { overwrite }),
        null,
        2,
      ),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function graphArtifactStoreCommand(
  operation: "inspect" | "prune",
  options: { maxBytes?: number; maxAgeDays?: number; dryRun?: boolean } = {},
): void {
  try {
    const result =
      operation === "inspect"
        ? { artifacts: inspectEngineeringGraphArtifactStore(process.cwd()) }
        : pruneEngineeringGraphArtifactStore(process.cwd(), options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function graphSimulateCommand(file: string, params: readonly string[] = [], worstCase = false): void {
  try {
    const definition = readEngineeringGraphFile(file, process.cwd(), params);
    console.log(
      JSON.stringify(
        simulateEngineeringGraph(definition, { retryMode: worstCase ? "worst_case" : "baseline" }),
        null,
        2,
      ),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function graphExplainCommand(graphId: string, nodeId: string): void {
  try {
    const state = loadEngineeringGraphState(process.cwd(), graphId);
    if (!state) throw new Error(`Persisted Engineering Graph not found or invalid: ${graphId}`);
    const node = state.definition.nodes.find((candidate) => candidate.id === nodeId);
    const signalAvailable = node?.waitFor?.signal
      ? engineeringGraphSignalAvailable(process.cwd(), graphId, nodeId, node.waitFor.signal, node.waitFor.expiresAt)
      : undefined;
    console.log(
      JSON.stringify(
        explainEngineeringGraphNode(state.definition, state, nodeId, new Date(), { signalAvailable }),
        null,
        2,
      ),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function graphResourcesCommand(
  graphId: string,
  operation: "inspect" | "archive" | "prune" | "promote",
  opts: { dryRun?: boolean; force?: boolean; target?: string } = {},
): Promise<void> {
  try {
    const workspace = process.cwd();
    const result =
      operation === "inspect"
        ? await inspectEngineeringGraphResources(workspace, graphId)
        : operation === "archive"
          ? archiveEngineeringGraphResources(workspace, graphId)
          : operation === "prune"
            ? await pruneEngineeringGraphResources(workspace, graphId, {
                dryRun: opts.dryRun,
                force: opts.force,
              })
            : await promoteEngineeringGraphResult(workspace, graphId, opts.target ?? "fan-in");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function loadGraphOrThrow(graphId: string): EngineeringGraphState {
  const state = loadEngineeringGraphState(process.cwd(), graphId);
  if (!state) throw new Error(`Persisted Engineering Graph not found or invalid: ${graphId}`);
  return state;
}

export async function graphControlCommand(graphId: string, command: DurableGraphControlCommand): Promise<void> {
  try {
    const workspace = process.cwd();
    const state = loadGraphOrThrow(graphId);
    const rejection = checkGraphControlTarget(state, command);
    if (rejection) throw new Error(rejection.message);
    if (!isSessionRunActive(workspace, `engineering-graph-${graphId}`)) {
      throw new Error(`Graph is not running: ${graphId}`);
    }
    const entry = await enqueueGraphControl(workspace, graphId, state.controlRunId, command);
    const target = "nodeId" in command && command.nodeId ? ` node ${command.nodeId}` : "";
    console.log(`Queued ${command.operation} for Graph ${graphId}${target} (seq ${entry.seq})`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function graphSignalCommand(graphId: string, name: string, payloadRaw?: string): Promise<void> {
  try {
    const workspace = process.cwd();
    const state = loadGraphOrThrow(graphId);
    const rejection = checkGraphSignalTarget(state, name);
    if (rejection) throw new Error(rejection.message);
    let payload: unknown;
    if (payloadRaw !== undefined) {
      try {
        payload = JSON.parse(payloadRaw) as unknown;
      } catch {
        throw new Error("Graph signal payload must be valid JSON");
      }
    }
    const signal = await enqueueEngineeringGraphSignal(workspace, graphId, name, payload);
    console.log(`Queued signal ${signal.name} for Graph ${graphId} (${signal.id})`);
    // Only a live owner consumes the mailbox; a wait-paused Graph needs its
    // definition again, which the CLI deliberately does not persist a path to.
    if (state.status === "paused") console.log(`Run "seekforge graph resume <file>" to continue ${graphId}.`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function graphEvidenceCommand(graphId: string | undefined, opts: { verify?: string } = {}): void {
  try {
    if (opts.verify !== undefined) {
      const raw = readFileIfExists(resolve(process.cwd(), opts.verify), 4 * 1024 * 1024);
      if (raw === undefined) throw new Error(`Graph evidence report not found: ${opts.verify}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw new Error(`Graph evidence report is not valid JSON: ${opts.verify}`);
      }
      const intact = verifyEngineeringGraphEvidenceIntegrity(parsed);
      console.log(`${opts.verify}\t${intact ? "intact" : "tampered"}`);
      if (!intact) process.exitCode = 1;
      return;
    }
    if (graphId === undefined) throw new Error("graph-id is required unless --verify is supplied");
    console.log(JSON.stringify(buildEngineeringGraphEvidenceReport(loadGraphOrThrow(graphId)), null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function graphCompareCommand(graphId: string, runNumber?: number): void {
  try {
    const state = loadGraphOrThrow(graphId);
    const snapshots = readEngineeringGraphRunSnapshots(process.cwd(), graphId);
    const baseline = runNumber === undefined ? snapshots.at(-1) : snapshots.find((run) => run.runNumber === runNumber);
    if (!baseline) throw new Error(`Graph comparison baseline not found: ${graphId}`);
    console.log(
      JSON.stringify(
        { baselineRunNumber: baseline.runNumber, comparison: compareEngineeringGraphRuns(baseline, state) },
        null,
        2,
      ),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function graphTemplateListCommand(): void {
  const entries = listEngineeringGraphTemplates(process.cwd());
  console.log(
    entries.length === 0
      ? "No registered Graph templates."
      : entries
          .map(
            (entry) =>
              `${entry.template.templateId}@${entry.template.version}\t${entry.registeredAt}${entry.deprecatedAt ? `\tdeprecated=${entry.deprecatedAt}` : ""}`,
          )
          .join("\n"),
  );
}

function resolveTemplateOrThrow(templateId: string, version: string): EngineeringGraphTemplate {
  const template = resolveEngineeringGraphTemplate(process.cwd(), templateId, version);
  if (!template) throw new Error(`Graph template not found: ${templateId}@${version}`);
  return template;
}

export function graphTemplateShowCommand(templateId: string, version: string): void {
  try {
    console.log(JSON.stringify(resolveTemplateOrThrow(templateId, version), null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function readTemplateFile(file: string): unknown {
  const raw = readFileIfExists(resolve(process.cwd(), file), 512 * 1024);
  if (raw === undefined) throw new Error(`Graph template file not found: ${file}`);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Graph template file is not valid JSON: ${file}`);
  }
}

export function graphTemplateRegisterCommand(file: string): void {
  try {
    const entry = registerEngineeringGraphTemplate(process.cwd(), readTemplateFile(file));
    console.log(`Registered Graph template: ${entry.template.templateId}@${entry.template.version}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function graphTemplateCompareCommand(templateId: string, version: string, file: string): void {
  try {
    const before = resolveTemplateOrThrow(templateId, version);
    const after = parseEngineeringGraphTemplate(readTemplateFile(file));
    const result = compareEngineeringGraphTemplates(before, after);
    console.log(JSON.stringify(result, null, 2));
    if (result.classification === "breaking") process.exitCode = 1;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function graphTemplateDeprecateCommand(templateId: string, version: string): void {
  try {
    const entry = deprecateEngineeringGraphTemplate(process.cwd(), templateId, version);
    console.log(`Deprecated Graph template: ${entry.template.templateId}@${entry.template.version}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function graphDeleteCommand(graphId: string): Promise<void> {
  try {
    const resources = await inspectEngineeringGraphResources(process.cwd(), graphId);
    if (resources.worktrees.length > 0) {
      throw new Error(`Graph managed resources must be pruned before deletion: ${graphId}`);
    }
    if (!removeEngineeringGraphState(process.cwd(), graphId))
      throw new Error(`Engineering Graph not found: ${graphId}`);
    console.log(`Removed Engineering Graph: ${graphId}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
