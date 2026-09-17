import type { ToolCall, ToolDefinitionForModel, ToolResult } from "@seekforge/shared";
import { estimateToolDefinitionsTokens } from "../agent/context.js";
import { builtinTools } from "../tools/builtins/index.js";
import type { ToolContext, ToolDispatcher } from "../tools/index.js";
import { zodToJsonSchema } from "../tools/json-schema.js";
import { createDispatcher, type ToolSpec } from "../tools/registry.js";
import type { AdaptiveToolDispatcher } from "./adaptive.js";
import { projectMcpServerStatus } from "./approvals.js";
import { createMcpClient } from "./client.js";
import { sanitizeMcpErrorMessage } from "./errors.js";
import { mcpTransportOf } from "./launch.js";
import {
  mcpResourceToolSpecs,
  TOOL_SEARCH_TOOL,
  type ToolSearchCatalog,
  toolSearchDescription,
  toolSearchSpec,
} from "./meta-tools.js";
import type { McpServerRequestHandlers } from "./server-requests.js";
import { buildMcpServerToolSet, isPermissionName, type McpClientEntry } from "./tools.js";
import type { McpServerConfig, McpServerTrust, McpTransportKind } from "./types.js";

/**
 * The live set of MCP connections behind one agent assembly.
 *
 * A server's tool list is not fixed: a server says so with
 * `notifications/tools/list_changed`, and the registry re-lists it. The running
 * loop sees the change on its next provider turn through
 * {@link createMcpAwareDispatcher} — the dispatcher's `revision()` moves, the
 * loop re-reads the catalog. Tool names are derived from (server, tool) alone,
 * so a refresh never renames a tool the model already knows, and an unchanged
 * list does not move the revision (the request prefix stays cacheable).
 */

/** Default share of the context budget MCP tool definitions may take before they are deferred. */
export const DEFAULT_MCP_TOOL_SEARCH_THRESHOLD = 10;

export type McpServerState =
  /** Connected (or connecting); tools listed at least once. */
  | "connected"
  /** Connected, but listing its tools failed; it contributes none. */
  | "failed"
  /** A repository-defined server the user has not decided on for this workspace. */
  | "pending"
  /** A repository-defined server the user declined for this workspace. */
  | "rejected"
  /** A user-owned server without `trusted: true`; never connected automatically. */
  | "disabled"
  /** A definition that cannot be used (bad transport or permission fields). */
  | "invalid";

export type McpServerStatus = {
  name: string;
  state: McpServerState;
  transport?: McpTransportKind;
  trust?: McpServerTrust;
  toolCount: number;
  error?: string;
};

export type McpRegistryEvent = {
  server: string;
  kind: "tools" | "prompts" | "resources" | "connection";
};

export type McpRegistry = {
  /** Moves whenever what the MCP-aware dispatcher advertises may have changed. */
  revision(): number;
  /** Live connection entries (the same array on every call, updated in place). */
  entries(): McpClientEntry[];
  /** Every connected server's tool specs, in config order then tools/list order. */
  toolSpecs(): readonly ToolSpec[];
  /** One status row per configured server, connected or not, in config order. */
  servers(): McpServerStatus[];
  /** Re-lists one server's tools now (what a tools/list_changed notification triggers). */
  refresh(server: string, signal?: AbortSignal): Promise<void>;
  /**
   * Re-decides whether `server` may connect (the user may have approved or
   * rejected it since), drops its old connection, and connects afresh when
   * allowed. Returns the resulting status.
   */
  reconnect(server: string, signal?: AbortSignal): Promise<McpServerStatus>;
  /** Registry events: tool/prompt/resource list changes and connection changes. */
  subscribe(listener: (event: McpRegistryEvent) => void): () => void;
  /** Share (0–100) of the context budget MCP tool definitions may take before deferral. */
  readonly toolSearchThreshold: number;
  dispose(): void;
};

export type LoadMcpOptions = {
  /**
   * Workspace whose project-server approvals apply. Defaults to the first
   * workspace root. Without one, no repository-defined server connects.
   */
  workspace?: string;
  /**
   * Origin of each server name — a config merge report's `mcpServerOrigins`.
   * A `repository` name connects only when approved; a `user` name only with
   * `trusted: true`. Names absent here: `trusted: true` connects as the user's,
   * otherwise a matching approval connects it as a project server.
   */
  origins?: Readonly<Record<string, "user" | "repository">>;
  /**
   * Percentage (0–100) of the context budget the MCP tool definitions may take
   * before they are deferred behind tool_search. 0 always defers, 100 never
   * does. Default {@link DEFAULT_MCP_TOOL_SEARCH_THRESHOLD}.
   */
  toolSearchThreshold?: number;
};

/** `user`/`project`: connect with that trust. Anything else: do not connect automatically. */
export type McpConnectionDecision = "user" | "project" | "pending" | "rejected" | "disabled";

/**
 * Whether a configured server may connect without an explicit per-action
 * request, and with what trust. The one rule every automatic connection goes
 * through; a surface that connects a server for an explicit management action
 * should pass `trust: decision === "user" || decision === "project" ? decision
 * : "untrusted"` to createMcpClient.
 */
export function mcpConnectionDecision(
  name: string,
  config: McpServerConfig,
  context: { workspace?: string; origin?: "user" | "repository" },
): McpConnectionDecision {
  if (context.origin !== "repository" && config.trusted === true) return "user";
  if (context.origin === "user") return "disabled";
  if (context.workspace === undefined) return context.origin === "repository" ? "pending" : "disabled";
  const status = projectMcpServerStatus(context.workspace, name, config);
  if (status === "approved") return "project";
  if (status === "rejected") return "rejected";
  return context.origin === "repository" ? "pending" : "disabled";
}

function validateThreshold(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MCP_TOOL_SEARCH_THRESHOLD;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError("mcpToolSearchThreshold must be a number from 0 to 100");
  }
  return value;
}

type Slot = {
  name: string;
  config: McpServerConfig;
  origin?: "user" | "repository";
  state: McpServerState;
  transport?: McpTransportKind;
  trust?: McpServerTrust;
  entry?: McpClientEntry;
  specs: ToolSpec[];
  summaries: Map<string, string>;
  fingerprint?: string;
  error?: string;
  /** Moves on every (re)connect or disconnect; work started under an older value is discarded. */
  generation: number;
  refreshing?: Promise<void>;
  refreshQueued: boolean;
};

type InternalRegistry = McpRegistry & {
  connectAll(signal?: AbortSignal): Promise<void>;
  /**
   * Resolves once the server owning `toolName` has no tool refresh in flight,
   * or after `timeoutMs`. A tool that belongs to no server settles at once.
   */
  settleRefresh(toolName: string, timeoutMs: number): Promise<void>;
  catalog: ToolSearchCatalog & { isLoaded(name: string): boolean; loadedNames(): readonly string[] };
  summaryOf(name: string): string;
};

function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

function createRegistry(
  servers: Record<string, McpServerConfig>,
  workspaceRoots: string[] | undefined,
  serverRequestHandlers: McpServerRequestHandlers | undefined,
  options: LoadMcpOptions,
): InternalRegistry {
  const toolSearchThreshold = validateThreshold(options.toolSearchThreshold);
  const workspace = options.workspace ?? workspaceRoots?.[0];
  const slots: Slot[] = [];
  const liveEntries: McpClientEntry[] = [];
  const listeners = new Set<(event: McpRegistryEvent) => void>();
  const loaded: string[] = [];
  const loadedSet = new Set<string>();
  let revision = 0;
  let disposed = false;

  for (const [name, value] of Object.entries(servers)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      warn(`warning: MCP server "${name}" has an invalid configuration`);
      continue;
    }
    slots.push({
      name,
      config: value,
      ...(options.origins?.[name] !== undefined ? { origin: options.origins[name] } : {}),
      state: "disabled",
      specs: [],
      summaries: new Map(),
      generation: 0,
      refreshQueued: false,
    });
  }

  const emit = (event: McpRegistryEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // Observers are advisory; one failing must not stop the others.
      }
    }
  };
  const bump = (): void => {
    revision++;
  };
  const syncEntries = (): void => {
    const next = slots.flatMap((slot) => (slot.entry ? [slot.entry] : []));
    const changed = next.length !== liveEntries.length || next.some((entry, index) => entry !== liveEntries[index]);
    liveEntries.splice(0, liveEntries.length, ...next);
    // Whether any server is connected decides whether the resource tools are advertised.
    if (changed) bump();
  };
  const find = (name: string): Slot | undefined => slots.find((slot) => slot.name === name);

  function disconnect(slot: Slot): void {
    slot.generation++;
    slot.entry?.client.dispose();
    const hadTools = slot.specs.length > 0;
    slot.entry = undefined;
    slot.specs = [];
    slot.summaries = new Map();
    slot.fingerprint = undefined;
    slot.trust = undefined;
    syncEntries();
    if (hadTools) {
      bump();
      emit({ server: slot.name, kind: "tools" });
    }
  }

  function onNotification(slot: Slot, generation: number, method: string): void {
    if (disposed || slot.generation !== generation) return;
    if (method === "notifications/tools/list_changed") {
      void scheduleRefresh(slot).catch(() => {});
    } else if (method === "notifications/prompts/list_changed") {
      emit({ server: slot.name, kind: "prompts" });
    } else if (method === "notifications/resources/list_changed") {
      emit({ server: slot.name, kind: "resources" });
    }
  }

  /** Applies the connection decision and, when allowed, creates the client. No I/O. */
  function prepare(slot: Slot): boolean {
    const decision = mcpConnectionDecision(slot.name, slot.config, {
      ...(workspace !== undefined ? { workspace } : {}),
      ...(slot.origin !== undefined ? { origin: slot.origin } : {}),
    });
    slot.error = undefined;
    try {
      slot.transport = mcpTransportOf(slot.config);
    } catch (error) {
      slot.transport = undefined;
      slot.state = "invalid";
      slot.error = sanitizeMcpErrorMessage(error);
      warn(`warning: MCP server "${slot.name}" has an invalid transport`);
      return false;
    }
    if (decision !== "user" && decision !== "project") {
      slot.state = decision;
      return false;
    }
    const { permission, toolPermissions } = slot.config;
    if (permission !== undefined && !isPermissionName(permission)) {
      slot.state = "invalid";
      warn(`warning: MCP server "${slot.name}" has an invalid permission`);
      return false;
    }
    if (
      toolPermissions !== undefined &&
      (typeof toolPermissions !== "object" ||
        toolPermissions === null ||
        Array.isArray(toolPermissions) ||
        Object.values(toolPermissions).some((value) => !isPermissionName(value)))
    ) {
      slot.state = "invalid";
      warn(`warning: MCP server "${slot.name}" has invalid toolPermissions`);
      return false;
    }
    const generation = ++slot.generation;
    const client = createMcpClient({
      name: slot.name,
      config: slot.config,
      trust: decision,
      ...(workspaceRoots !== undefined ? { workspaceRoots } : {}),
      ...(serverRequestHandlers !== undefined ? { serverRequestHandlers } : {}),
      onNotification: (notification) => onNotification(slot, generation, notification.method),
    });
    // The entry object outlives reconnects: tool specs hold it and read
    // `client` at call time.
    const entry: McpClientEntry = slot.entry ?? { serverName: slot.name, client, trusted: true };
    entry.client = client;
    entry.trusted = true;
    entry.trust = decision;
    if (permission !== undefined) entry.permission = permission;
    else delete entry.permission;
    if (toolPermissions !== undefined) entry.toolPermissions = toolPermissions;
    else delete entry.toolPermissions;
    slot.entry = entry;
    slot.trust = decision;
    slot.state = "connected";
    syncEntries();
    return true;
  }

  /** Lists the slot's tools under its current generation; `keepOnFailure` keeps what it had. */
  async function relist(slot: Slot, signal: AbortSignal | undefined, keepOnFailure: boolean): Promise<void> {
    const entry = slot.entry;
    if (!entry) return;
    const generation = slot.generation;
    try {
      const set = await buildMcpServerToolSet(entry, signal);
      if (disposed || slot.generation !== generation) return;
      slot.state = "connected";
      slot.error = undefined;
      if (set.fingerprint === slot.fingerprint) return;
      slot.specs = set.specs;
      slot.summaries = set.summaries;
      slot.fingerprint = set.fingerprint;
      bump();
      emit({ server: slot.name, kind: "tools" });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (disposed || slot.generation !== generation) return;
      const message = sanitizeMcpErrorMessage(error);
      slot.error = message;
      warn(`warning: MCP server "${slot.name}" unavailable: ${message}`);
      if (keepOnFailure && slot.fingerprint !== undefined) return;
      slot.state = "failed";
      if (slot.specs.length > 0) {
        slot.specs = [];
        slot.summaries = new Map();
        slot.fingerprint = undefined;
        bump();
        emit({ server: slot.name, kind: "tools" });
      }
    }
  }

  /** Coalesces bursts of list_changed: one refresh at a time, one more if asked meanwhile. */
  function scheduleRefresh(slot: Slot, signal?: AbortSignal): Promise<void> {
    if (slot.refreshing) {
      slot.refreshQueued = true;
      return slot.refreshing;
    }
    const run = async (): Promise<void> => {
      do {
        slot.refreshQueued = false;
        await relist(slot, signal, true);
      } while (slot.refreshQueued && !disposed);
    };
    slot.refreshing = run().finally(() => {
      slot.refreshing = undefined;
    });
    return slot.refreshing;
  }

  const allSpecs = (): ToolSpec[] => slots.flatMap((slot) => slot.specs);

  const catalog: InternalRegistry["catalog"] = {
    searchable: () =>
      slots.flatMap((slot) =>
        slot.specs.map((spec) => ({ definition: definitionOf(spec), summary: slot.summaries.get(spec.name) ?? "" })),
      ),
    load(names) {
      let changed = false;
      for (const name of names) {
        if (loadedSet.has(name)) continue;
        loadedSet.add(name);
        loaded.push(name);
        changed = true;
      }
      if (changed) bump();
    },
    isLoaded: (name) => loadedSet.has(name),
    loadedNames: () => loaded,
  };

  const statusOf = (slot: Slot): McpServerStatus => ({
    name: slot.name,
    state: slot.state,
    ...(slot.transport !== undefined ? { transport: slot.transport } : {}),
    ...(slot.trust !== undefined ? { trust: slot.trust } : {}),
    toolCount: slot.specs.length,
    ...(slot.error !== undefined ? { error: slot.error } : {}),
  });

  return {
    toolSearchThreshold,
    revision: () => revision,
    entries: () => liveEntries,
    toolSpecs: allSpecs,
    servers: () => slots.map(statusOf),
    async refresh(server, signal) {
      const slot = find(server);
      if (!slot) throw new RangeError(`no MCP server named "${server}" is configured`);
      if (disposed) return;
      await scheduleRefresh(slot, signal);
    },
    async reconnect(server, signal) {
      const slot = find(server);
      if (!slot) throw new RangeError(`no MCP server named "${server}" is configured`);
      if (disposed) throw new Error("MCP registry is disposed");
      const previous = slot.entry;
      if (previous) {
        // Retire the old connection first: its late notifications and list
        // results are discarded by generation.
        slot.generation++;
        previous.client.dispose();
      }
      if (prepare(slot)) {
        await relist(slot, signal, false);
      } else if (previous) {
        disconnect(slot);
      }
      emit({ server: slot.name, kind: "connection" });
      return statusOf(slot);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const slot of slots) {
        slot.generation++;
        slot.entry?.client.dispose();
      }
      listeners.clear();
    },
    async settleRefresh(toolName, timeoutMs) {
      const refreshing = slots.find((slot) => slot.specs.some((spec) => spec.name === toolName))?.refreshing;
      if (!refreshing) return;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        refreshing.catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    },
    async connectAll(signal) {
      const connecting = slots.filter((slot) => prepare(slot));
      await Promise.all(connecting.map((slot) => relist(slot, signal, false)));
    },
    catalog,
    summaryOf: (name) => {
      for (const slot of slots) {
        const summary = slot.summaries.get(name);
        if (summary !== undefined) return summary;
      }
      return "";
    },
  };
}

const definitionCache = new WeakMap<ToolSpec, ToolDefinitionForModel>();

/**
 * One stable definition object per spec: context.ts caches token estimates by
 * object identity, so re-deriving definitions every turn would re-serialize
 * every schema every turn.
 */
function definitionOf(spec: ToolSpec): ToolDefinitionForModel {
  let definition = definitionCache.get(spec);
  if (!definition) {
    definition = {
      name: spec.name,
      description: spec.description,
      parameters: spec.parametersOverride ?? zodToJsonSchema(spec.schema),
    };
    definitionCache.set(spec, definition);
  }
  return definition;
}

const registries = new WeakMap<McpRegistry, InternalRegistry>();

/** How long a tool call waits for a tools/list refresh it may have triggered. */
const REFRESH_SETTLE_MS = 2_000;

/**
 * Creates a client per configured server that may connect (see
 * {@link mcpConnectionDecision}) and lists their tools.
 *
 * - `specs` — the servers' tools plus list_mcp_resources/read_mcp_resource, as
 *   a snapshot for `createDefaultDispatcher(specs)`. That dispatcher never sees
 *   a later tools/list_changed and never defers.
 * - `registry` — the live set; hand it to {@link createMcpAwareDispatcher} for
 *   refreshed tools and tool_search deferral, and to a UI for status,
 *   reconnects and change events.
 * - `entries` — the live connections for resource/prompt access
 *   (listMcpResources / readMcpResource); updated in place on reconnect.
 * - `dispose()` shuts every client down (kills the child processes).
 *
 * `workspaceRoots` (absolute paths) is advertised to each server via the roots
 * capability and answered on roots/list. `serverRequestHandlers` answers the
 * requests that go the other way (sampling/elicitation); each capability is
 * advertised only when its handler is supplied.
 */
export async function loadMcpToolSpecs(
  servers: Record<string, McpServerConfig>,
  workspaceRoots?: string[],
  signal?: AbortSignal,
  serverRequestHandlers?: McpServerRequestHandlers,
  options: LoadMcpOptions = {},
): Promise<{ specs: ToolSpec[]; entries: McpClientEntry[]; dispose: () => void; registry: McpRegistry }> {
  const registry = createRegistry(servers, workspaceRoots, serverRequestHandlers, options);
  const dispose = () => registry.dispose();
  try {
    await registry.connectAll(signal);
  } catch (err) {
    dispose();
    throw err;
  }
  const publicRegistry: McpRegistry = registry;
  registries.set(publicRegistry, registry);
  const entries = registry.entries();
  const specs = [
    ...registry.toolSpecs(),
    ...(entries.length > 0 ? mcpResourceToolSpecs(() => registry.entries()) : []),
  ];
  return { specs, entries, dispose, registry: publicRegistry };
}

/**
 * The default dispatcher (built-in tools + `extraTools`) plus the registry's
 * MCP tools, resource tools and tool_search, kept current as the registry
 * changes.
 *
 * Deferral (`listForBudget`): while the MCP tool definitions fit in
 * `toolSearchThreshold`% of the request budget they are advertised in full.
 * Past that, each is advertised only as a line in tool_search's description,
 * and tool_search loads full schemas for later turns. Built-in tools and the
 * MCP helper tools are always advertised in full.
 */
export function createMcpAwareDispatcher(registry: McpRegistry, extraTools: ToolSpec[] = []): AdaptiveToolDispatcher {
  const internal = registries.get(registry);
  if (!internal) throw new TypeError("createMcpAwareDispatcher needs a registry returned by loadMcpToolSpecs");
  const fixed = [...builtinTools(), ...extraTools];
  const helpers = mcpResourceToolSpecs(() => internal.entries());
  const search = toolSearchSpec(internal.catalog);
  const fixedDefinitions = [...fixed, ...helpers].map(definitionOf);

  let builtFor = -1;
  let dispatcher: ToolDispatcher | undefined;
  let serverSpecs: readonly ToolSpec[] = [];
  const current = (): ToolDispatcher => {
    const specs = internal.toolSpecs();
    if (!dispatcher || builtFor !== internal.revision()) {
      try {
        dispatcher = createDispatcher([...fixed, ...helpers, search, ...specs]);
        serverSpecs = specs;
      } catch (error) {
        // A refreshed list that cannot be registered (a name clash) keeps the
        // previous tool set rather than taking the whole dispatcher down.
        if (!dispatcher) throw error;
        warn(`warning: MCP tool refresh ignored: ${sanitizeMcpErrorMessage(error)}`);
      }
      builtFor = internal.revision();
    }
    return dispatcher!;
  };

  const listCache = new Map<string, ToolDefinitionForModel[]>();
  let listCacheRevision = -1;
  let searchDefinition: { index: string; definition: ToolDefinitionForModel } | undefined;

  const serverDefinitions = (): ToolDefinitionForModel[] => {
    current();
    return serverSpecs.map(definitionOf);
  };
  const withAvailability = (definitions: ToolDefinitionForModel[]): ToolDefinitionForModel[] =>
    internal.entries().length > 0 ? definitions : definitions.filter((d) => !helpers.some((h) => h.name === d.name));

  return {
    revision: () => internal.revision(),
    list(): ToolDefinitionForModel[] {
      return withAvailability([...fixedDefinitions, ...serverDefinitions()]);
    },
    listForBudget(budgetTokens: number): ToolDefinitionForModel[] {
      const revision = internal.revision();
      if (revision !== listCacheRevision) {
        listCache.clear();
        listCacheRevision = revision;
      }
      const key = String(budgetTokens);
      const cached = listCache.get(key);
      if (cached) return cached;
      const mcp = serverDefinitions();
      const threshold = internal.toolSearchThreshold;
      const defer =
        mcp.length > 0 &&
        threshold < 100 &&
        (threshold === 0 ||
          estimateToolDefinitionsTokens(mcp) > Math.floor((Math.max(0, budgetTokens) * threshold) / 100));
      let result: ToolDefinitionForModel[];
      if (!defer) {
        result = withAvailability([...fixedDefinitions, ...mcp]);
      } else {
        const index = mcp.map((definition) => ({
          name: definition.name,
          summary: internal.summaryOf(definition.name),
        }));
        const description = toolSearchDescription(index);
        if (searchDefinition?.index !== description) {
          searchDefinition = {
            index: description,
            definition: { name: TOOL_SEARCH_TOOL, description, parameters: definitionOf(search).parameters },
          };
        }
        const known = new Map(mcp.map((definition) => [definition.name, definition]));
        const loaded = internal.catalog.loadedNames().flatMap((name) => {
          const definition = known.get(name);
          return definition ? [definition] : [];
        });
        result = withAvailability([...fixedDefinitions, searchDefinition.definition, ...loaded]);
      }
      listCache.set(key, result);
      return result;
    },
    unadvertisedHint(name: string, advertised: ReadonlySet<string>): string | undefined {
      if (!advertised.has(TOOL_SEARCH_TOOL) || internal.catalog.isLoaded(name)) return undefined;
      if (!internal.toolSpecs().some((spec) => spec.name === name)) return undefined;
      return (
        `Tool ${name} is deferred: its schema has not been loaded. ` +
        `Call ${TOOL_SEARCH_TOOL} with {"query": "select:${name}"} first; the tool is callable from the turn after that.`
      );
    },
    async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
      const result = await current().execute(call, ctx);
      // A call that changed its server's tool list (the server said so before
      // answering) should see the new list on the very next turn.
      await internal.settleRefresh(call.name, REFRESH_SETTLE_MS);
      return result;
    },
  };
}
