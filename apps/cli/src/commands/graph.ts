import {
  engineeringGraphStateExists,
  listEngineeringGraphStates,
  loadEngineeringGraphState,
  parseEngineeringGraphDefinition,
  readFileIfExists,
  removeEngineeringGraphState,
  runEngineeringGraph,
  validateEngineeringGraphRunOptions,
  validateEngineeringGraphWorkspaces,
  type EngineeringGraphDefinition,
  type AgentCoreDeps,
  type GraphFunctionHandler,
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
};

export function readEngineeringGraphFile(file: string, workspace = process.cwd()): EngineeringGraphDefinition {
  const raw = readFileIfExists(resolve(workspace, file), 512 * 1024);
  if (raw === undefined) throw new Error(`Engineering Graph file not found: ${file}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Engineering Graph file is not valid JSON: ${file}`);
  }
  return parseEngineeringGraphDefinition(parsed);
}

const handlers: Readonly<Record<string, GraphFunctionHandler>> = {
  noop: () => ({ output: null }),
  collect: ({ dependencies }) => ({
    output: Object.fromEntries([...dependencies].map(([id, result]) => [id, result.output])),
  }),
};

export async function graphValidateCommand(file: string): Promise<void> {
  try {
    const graph = readEngineeringGraphFile(file);
    console.log(`${graph.graphId}\tvalid\t${graph.nodes.length} node(s)`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function graphRunCommand(file: string, opts: GraphRunCliOptions): Promise<void> {
  const workspace = process.cwd();
  let graph: EngineeringGraphDefinition;
  try {
    graph = readEngineeringGraphFile(file, workspace);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  const requiresAgentRuntime = (definition: EngineeringGraphDefinition): boolean =>
    definition.nodes.some(
      (node) =>
        node.kind === "agent" || node.kind === "loop" || (node.graph ? requiresAgentRuntime(node.graph) : false),
    );
  const needsRuntime = requiresAgentRuntime(graph);
  try {
    validateEngineeringGraphRunOptions(graph, {
      workspace,
      handlers,
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
      handlers,
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

export function graphDeleteCommand(graphId: string): void {
  try {
    if (!removeEngineeringGraphState(process.cwd(), graphId))
      throw new Error(`Engineering Graph not found: ${graphId}`);
    console.log(`Removed Engineering Graph: ${graphId}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
