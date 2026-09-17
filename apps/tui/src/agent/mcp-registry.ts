/**
 * The TUI's view of the session's MCP connections.
 *
 * Core's registry (`loadMcpToolSpecs(...).registry`) is the one owner of
 * connection state: which servers may connect (a user entry's `trusted` flag, a
 * repository entry's approval for this workspace), live tool lists, reconnects
 * and the tool_search deferral a run's dispatcher reads. This module adds only
 * what `/mcp` shows on top of it — where each definition came from, its raw
 * target, prompt and resource counts, the definition a repository server asks
 * the user to approve — and the two management actions whose effect core
 * leaves to the host: switching a user server's trust flag and recording a
 * decision on a repository server.
 */

import {
  approveProjectMcpServer,
  formatMcpServerDefinition,
  loadMcpToolSpecs,
  rejectProjectMcpServer,
  type LoadMcpOptions,
  type McpClient,
  type McpClientEntry,
  type McpRegistry as CoreMcpRegistry,
  type McpServerConfig,
  type McpServerRequestHandlers,
  type McpServerState,
  type McpTransportKind,
} from "@seekforge/core";

export type { McpServerState };
export type McpServerOrigin = "user" | "repository" | "plugin";

export type McpServerStatus = {
  name: string;
  state: McpServerState;
  origin: McpServerOrigin;
  /** Absent when the definition names a transport core does not know. */
  transport?: McpTransportKind;
  /** The raw command line or URL, as configured (references unexpanded). */
  target: string;
  tools: number;
  prompts?: number;
  resources?: number;
  error?: string;
  /**
   * A repository server's definition as the user reviews it before approving
   * (core's formatMcpServerDefinition: unexpanded, trust flag omitted).
   */
  definition?: string;
};

export type McpRegistry = {
  /** The live core registry; hand it to createMcpAwareDispatcher for a run. */
  readonly core: CoreMcpRegistry;
  /** Live connections for resource and prompt access (updated in place on reconnect). */
  entries(): McpClientEntry[];
  statuses(): McpServerStatus[];
  config(name: string): McpServerConfig | undefined;
  /** Re-decides whether `name` may connect and connects it afresh when it may. */
  reconnect(name: string): Promise<McpServerStatus | undefined>;
  /**
   * Applies a user server's new `trusted` flag to the running session (the
   * caller has already written it to the user config) and reconnects it.
   */
  setTrusted(name: string, trusted: boolean): Promise<McpServerStatus | undefined>;
  /** Records the user's decision on a repository server for this workspace, then reconnects it. */
  decide(name: string, decision: "approve" | "reject"): Promise<McpServerStatus | undefined>;
  /** Asks every connected server for its prompt and resource counts. */
  refreshCounts(): Promise<void>;
  subscribe(listener: () => void): () => void;
  dispose(): void;
};

export type McpLoaded = { registry: CoreMcpRegistry; dispose: () => void };

/** Test seam: how the core registry is created. */
export type McpLoader = (
  servers: Record<string, McpServerConfig>,
  roots: string[] | undefined,
  handlers: McpServerRequestHandlers | undefined,
  options: LoadMcpOptions,
) => Promise<McpLoaded>;

export type McpRegistryOptions = {
  servers: Record<string, McpServerConfig>;
  /** Origin of each configured name (the merge report plus --mcp-config names); absent = plugin. */
  origins: Record<string, "user" | "repository">;
  /** The project whose approvals apply to repository servers. */
  workspace: string;
  /** Advertised to each server as its roots (roots/list). */
  roots?: string[];
  handlers?: McpServerRequestHandlers;
  /** `mcpToolSearchThreshold`; core validates it (a bad value rejects the load). */
  toolSearchThreshold?: number;
  /** True once the TUI owns the terminal: core's warnings are swallowed, not printed. */
  quiet?: () => boolean;
  loader?: McpLoader;
};

const defaultLoader: McpLoader = async (servers, roots, handlers, options) => {
  const loaded = await loadMcpToolSpecs(servers, roots, undefined, handlers, options);
  return { registry: loaded.registry, dispose: loaded.dispose };
};

type StderrSink = { text: string };
const stderrSinks = new Set<StderrSink>();
let originalStderrWrite: typeof process.stderr.write | undefined;

/**
 * Runs `fn` with stderr writes held back. Core reports an unreachable or
 * invalid server on stderr as well as in its status, and a stray write garbles
 * the screen once the TUI owns the terminal; the status is what `/mcp` shows.
 * Calls overlap, so the patch is installed once and removed with the last one.
 * Before the screen is taken (`enabled` false) stderr is the right channel.
 */
async function withCapturedStderr<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
  if (!enabled) return fn();
  const sink: StderrSink = { text: "" };
  if (stderrSinks.size === 0) {
    originalStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      for (const open of stderrSinks) open.text += text;
      return true;
    }) as typeof process.stderr.write;
  }
  stderrSinks.add(sink);
  try {
    return await fn();
  } finally {
    stderrSinks.delete(sink);
    if (stderrSinks.size === 0 && originalStderrWrite) {
      process.stderr.write = originalStderrWrite;
      originalStderrWrite = undefined;
    }
  }
}

/** What the definition points at, chosen the way core picks the transport. */
function targetOf(config: McpServerConfig | undefined): string {
  if (!config) return "";
  const remote = config.type === "http" || config.type === "sse" || (config.type === undefined && Boolean(config.url));
  if (remote) return typeof config.url === "string" ? config.url : "";
  const args = Array.isArray(config.args) ? config.args.filter((arg) => typeof arg === "string") : [];
  return [typeof config.command === "string" ? config.command : "", ...args].join(" ").trim();
}

type Counts = { client: McpClient; prompts?: number; resources?: number };

export async function createMcpRegistry(opts: McpRegistryOptions): Promise<McpRegistry> {
  const loader = opts.loader ?? defaultLoader;
  // Our own copies: `setTrusted` changes the flag on the object core's registry
  // was built from, which must never be the app's config object. Null
  // prototype: a server named "__proto__" stays a data key.
  const servers = Object.create(null) as Record<string, McpServerConfig>;
  for (const [name, config] of Object.entries(opts.servers)) {
    servers[name] = typeof config === "object" && config !== null && !Array.isArray(config) ? { ...config } : config;
  }
  const quiet = (): boolean => opts.quiet?.() ?? false;
  const loaded = await withCapturedStderr(quiet(), () =>
    loader(servers, opts.roots, opts.handlers, {
      workspace: opts.workspace,
      origins: opts.origins,
      ...(opts.toolSearchThreshold !== undefined ? { toolSearchThreshold: opts.toolSearchThreshold } : {}),
    }),
  );
  const core = loaded.registry;
  const counts = new Map<string, Counts>();
  const listeners = new Set<() => void>();
  let disposed = false;

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const unsubscribeCore = core.subscribe((event) => {
    // A new connection has not been counted yet.
    if (event.kind === "connection") counts.delete(event.server);
    notify();
  });

  const originOf = (name: string): McpServerOrigin => opts.origins[name] ?? "plugin";

  const statuses = (): McpServerStatus[] => {
    const live = new Map(core.entries().map((entry) => [entry.serverName, entry.client]));
    return core.servers().map((server) => {
      const config = servers[server.name];
      const origin = originOf(server.name);
      const counted = counts.get(server.name);
      const current = counted !== undefined && live.get(server.name) === counted.client ? counted : undefined;
      return {
        name: server.name,
        state: server.state,
        origin,
        ...(server.transport !== undefined ? { transport: server.transport } : {}),
        target: targetOf(config),
        tools: server.toolCount,
        ...(current?.prompts !== undefined ? { prompts: current.prompts } : {}),
        ...(current?.resources !== undefined ? { resources: current.resources } : {}),
        ...(server.error !== undefined ? { error: server.error } : {}),
        ...(origin === "repository" && config !== undefined ? { definition: formatMcpServerDefinition(config) } : {}),
      };
    });
  };

  const statusOf = (name: string): McpServerStatus | undefined => statuses().find((status) => status.name === name);

  const reconnect = async (name: string): Promise<McpServerStatus | undefined> => {
    if (disposed || !Object.hasOwn(servers, name)) return undefined;
    counts.delete(name);
    await withCapturedStderr(quiet(), () => core.reconnect(name));
    return statusOf(name);
  };

  return {
    core,
    entries: () => core.entries(),
    statuses,
    config: (name) => (Object.hasOwn(servers, name) ? servers[name] : undefined),
    reconnect,
    async setTrusted(name, trusted) {
      const config = Object.hasOwn(servers, name) ? servers[name] : undefined;
      if (!config || originOf(name) !== "user") return undefined;
      // Core decides a user entry's connection from this flag on every
      // reconnect; the config file already says the same.
      config.trusted = trusted;
      return reconnect(name);
    },
    async decide(name, decision) {
      const config = Object.hasOwn(servers, name) ? servers[name] : undefined;
      if (!config || originOf(name) !== "repository") return undefined;
      if (decision === "approve") approveProjectMcpServer(opts.workspace, name, config);
      else rejectProjectMcpServer(opts.workspace, name, config);
      return reconnect(name);
    },
    async refreshCounts() {
      await Promise.all(
        core.entries().map(async (entry) => {
          const client = entry.client;
          const [prompts, resources] = await Promise.all([
            client.listPrompts().then(
              (list) => list.length,
              () => undefined,
            ),
            client.listResources().then(
              (list) => list.length,
              () => undefined,
            ),
          ]);
          // A reconnect while this was out replaced the client; its counts are stale.
          if (disposed || entry.client !== client) return;
          counts.set(entry.serverName, {
            client,
            ...(prompts !== undefined ? { prompts } : {}),
            ...(resources !== undefined ? { resources } : {}),
          });
        }),
      );
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeCore();
      listeners.clear();
      loaded.dispose();
    },
  };
}
