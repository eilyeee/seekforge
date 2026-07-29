import {
  graphHandlersWithPlugins,
  archiveEngineeringGraphResources,
  engineeringGraphStateExists,
  engineeringGraphNeedsAgentRuntime,
  inspectEngineeringGraphResources,
  listEngineeringGraphStates,
  loadPluginContributions,
  loadEngineeringGraphState,
  materializeEngineeringGraph,
  planEngineeringGraph,
  promoteEngineeringGraphResult,
  pruneEngineeringGraphResources,
  readFileIfExists,
  removeEngineeringGraphState,
  runEngineeringGraph,
  validateEngineeringGraphRunOptions,
  validateEngineeringGraphWorkspaces,
  type EngineeringGraphDefinition,
  type AgentCoreDeps,
} from "@seekforge/core";
import { resolve } from "node:path";
import { fail } from "../colors.js";
import { loadConfig } from "../config.js";
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
  let graph: EngineeringGraphDefinition;
  try {
    graphHandlers = graphHandlersWithPlugins(loadPluginContributions(workspace));
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
    const state = await runEngineeringGraph(deps, graph, {
      workspace,
      handlers: graphHandlers,
      ...(signal ? { signal } : {}),
      ...(opts.resume ? { resume: true } : {}),
      ...(opts.restart ? { restart: true } : {}),
      ...(opts.rerun?.length ? { rerunFrom: opts.rerun } : {}),
      ...(opts.approve?.length ? { approvedNodeIds: opts.approve } : {}),
      onEvent: (event) =>
        console.log(
          `[${event.sequence}] ${event.type}${event.nodeId ? ` ${event.nodeId}` : ""}${event.status ? ` ${event.status}` : ""}`,
        ),
    });
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

export function graphListCommand(): void {
  console.log(
    listEngineeringGraphStates(process.cwd())
      .map((state) => `${state.graphId}\t${state.status}\t${state.results.length}\t${state.updatedAt}`)
      .join("\n"),
  );
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
