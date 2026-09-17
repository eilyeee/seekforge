/**
 * The TUI's live MCP connections, one per server, so `/mcp` can show each
 * server's state and reconnect or switch one server without restarting.
 *
 * Construction and validation stay with core: each server is connected through
 * `loadMcpToolSpecs` with a one-entry map, which refuses untrusted and invalid
 * entries exactly as a whole-config load would. What this adds is per-server
 * bookkeeping: which servers are connected, which failed and why, and the
 * current tool specs a new run should get.
 */

import {
  loadMcpToolSpecs,
  sanitizeMcpErrorMessage,
  type McpClientEntry,
  type McpServerConfig,
  type McpServerRequestHandlers,
  type ToolSpec,
} from "@seekforge/core";

export type McpServerState = "connected" | "failed" | "untrusted" | "pending";
export type McpServerOrigin = "user" | "repository" | "plugin";

export type McpServerStatus = {
  name: string;
  state: McpServerState;
  origin: McpServerOrigin;
  transport: "stdio" | "http";
  /** The raw command line or URL, as configured. */
  target: string;
  tools: number;
  prompts?: number;
  resources?: number;
  error?: string;
};

type Connection = { entries: McpClientEntry[]; specs: ToolSpec[]; dispose: () => void };

export type McpLoader = (
  servers: Record<string, McpServerConfig>,
  roots: string[] | undefined,
  signal: AbortSignal | undefined,
  handlers: McpServerRequestHandlers | undefined,
) => Promise<Connection>;

export type McpRegistry = {
  /** Tool specs of every connected server, in config order. */
  specs(): ToolSpec[];
  entries(): McpClientEntry[];
  statuses(): McpServerStatus[];
  config(name: string): McpServerConfig | undefined;
  /** Drops and re-creates one server's connection. */
  reconnect(name: string): Promise<McpServerStatus | undefined>;
  /** Replaces one server's config (e.g. after its trust flag changed) and reconnects it. */
  update(name: string, config: McpServerConfig): Promise<McpServerStatus | undefined>;
  /** Asks every connected server for its prompt and resource counts. */
  refreshCounts(): Promise<void>;
  subscribe(listener: () => void): () => void;
  dispose(): void;
};

export type McpRegistryOptions = {
  servers: Record<string, McpServerConfig>;
  /** Origin of each configured name; names absent here came from a plugin. */
  origins: Record<string, "user" | "repository">;
  /** Advertised to each server as its roots (roots/list). */
  roots?: string[];
  handlers?: McpServerRequestHandlers;
  loader?: McpLoader;
  /** True once the TUI owns the terminal: loader warnings are captured, not printed. */
  quiet?: () => boolean;
};

const defaultLoader: McpLoader = (servers, roots, signal, handlers) =>
  loadMcpToolSpecs(servers, roots, signal, handlers);

type StderrSink = { text: string };
const stderrSinks = new Set<StderrSink>();
let originalStderrWrite: typeof process.stderr.write | undefined;

/**
 * Runs `fn` with stderr writes captured. Core's loader reports an unreachable
 * server on stderr, which is the only place the failure reason is available —
 * and a stray write garbles the screen once the TUI owns the terminal. Loads
 * overlap, so the patch is installed once and removed with the last capture;
 * every capture sees every write made while it was open. Before the screen is
 * taken (`enabled` false) stderr is the right channel and nothing is captured.
 */
async function withCapturedStderr<T>(enabled: boolean, fn: () => Promise<T>): Promise<{ value: T; captured: string }> {
  if (!enabled) return { value: await fn(), captured: "" };
  const sink: StderrSink = { text: "" };
  if (stderrSinks.size === 0) {
    const original = process.stderr.write;
    originalStderrWrite = original;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      for (const open of stderrSinks) open.text += text;
      return true;
    }) as typeof process.stderr.write;
  }
  stderrSinks.add(sink);
  try {
    return { value: await fn(), captured: sink.text };
  } finally {
    stderrSinks.delete(sink);
    if (stderrSinks.size === 0 && originalStderrWrite) {
      process.stderr.write = originalStderrWrite;
      originalStderrWrite = undefined;
    }
  }
}

function warningReason(captured: string, name: string): string | undefined {
  const prefix = `warning: MCP server "${name}" `;
  const line = captured.split("\n").find((l) => l.startsWith(prefix));
  return line ? line.slice(prefix.length).replace(/^unavailable: /, "") : undefined;
}

export async function createMcpRegistry(opts: McpRegistryOptions): Promise<McpRegistry> {
  const loader = opts.loader ?? defaultLoader;
  const configs = new Map<string, McpServerConfig>(Object.entries(opts.servers));
  const connections = new Map<string, Connection>();
  const statuses = new Map<string, McpServerStatus>();
  const generations = new Map<string, number>();
  const listeners = new Set<() => void>();
  let disposed = false;

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const baseStatus = (name: string, config: McpServerConfig): McpServerStatus => ({
    name,
    state: config.trusted === true ? "pending" : "untrusted",
    origin: opts.origins[name] ?? "plugin",
    transport: config.url ? "http" : "stdio",
    target: config.url ?? [config.command ?? "", ...(config.args ?? [])].join(" ").trim(),
    tools: 0,
  });

  const drop = (name: string): void => {
    connections.get(name)?.dispose();
    connections.delete(name);
  };

  const connect = async (name: string): Promise<McpServerStatus | undefined> => {
    const config = configs.get(name);
    if (!config) return undefined;
    const generation = (generations.get(name) ?? 0) + 1;
    generations.set(name, generation);
    drop(name);
    const pending = baseStatus(name, config);
    statuses.set(name, pending);
    notify();
    if (pending.state === "untrusted") return pending;

    let status: McpServerStatus;
    let connection: Connection | undefined;
    try {
      const { value, captured } = await withCapturedStderr(opts.quiet?.() ?? false, async () => {
        const loaded = await loader({ [name]: config }, opts.roots, undefined, opts.handlers);
        let probeError: string | undefined;
        // Zero specs is either an empty server or a failed one; ask once.
        if (loaded.specs.length === 0 && loaded.entries[0]) {
          try {
            await loaded.entries[0].client.listTools();
          } catch (error) {
            probeError = sanitizeMcpErrorMessage(error);
          }
        }
        return { loaded, probeError };
      });
      connection = value.loaded;
      if (value.loaded.entries.length === 0) {
        status = {
          ...pending,
          state: "failed",
          error: warningReason(captured, name) ?? "invalid server configuration",
        };
      } else if (value.probeError !== undefined) {
        status = { ...pending, state: "failed", error: value.probeError };
      } else {
        status = { ...pending, state: "connected", tools: value.loaded.specs.length };
      }
    } catch (error) {
      status = { ...pending, state: "failed", error: sanitizeMcpErrorMessage(error) };
    }
    // A newer reconnect (or dispose) owns this server now: discard this result.
    if (disposed || generations.get(name) !== generation) {
      connection?.dispose();
      return statuses.get(name);
    }
    if (connection && status.state === "connected") connections.set(name, connection);
    else connection?.dispose();
    statuses.set(name, status);
    notify();
    return status;
  };

  for (const [name, config] of configs) statuses.set(name, baseStatus(name, config));
  await Promise.all([...configs.keys()].map((name) => connect(name)));

  const ordered = <T>(pick: (connection: Connection) => T[]): T[] =>
    [...configs.keys()].flatMap((name) => {
      const connection = connections.get(name);
      return connection ? pick(connection) : [];
    });

  return {
    specs: () => ordered((c) => c.specs),
    entries: () => ordered((c) => c.entries),
    statuses: () => [...configs.keys()].map((name) => statuses.get(name) as McpServerStatus),
    config: (name) => configs.get(name),
    reconnect: (name) => connect(name),
    update: (name, config) => {
      if (!configs.has(name)) return Promise.resolve(undefined);
      configs.set(name, config);
      return connect(name);
    },
    async refreshCounts() {
      await Promise.all(
        [...connections.entries()].map(async ([name, connection]) => {
          const client = connection.entries[0]?.client;
          if (!client) return;
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
          const current = statuses.get(name);
          if (!current || connections.get(name) !== connection) return;
          statuses.set(name, {
            ...current,
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
      disposed = true;
      for (const name of [...connections.keys()]) drop(name);
      listeners.clear();
    },
  };
}
