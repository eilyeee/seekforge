import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { McpError } from "./errors.js";
import { createMcpHttpTransport } from "./http.js";
import type { McpPrompt, McpResource, McpServerConfig, McpTool } from "./types.js";

export { McpError };

export type McpClientOptions = {
  /** Server name (config key) — used in log prefixes and error messages. */
  name: string;
  config: McpServerConfig;
  /** Default per-request timeout. */
  requestTimeoutMs?: number;
  /**
   * Absolute workspace path(s) advertised to the server as filesystem roots
   * (capabilities.roots + answers to server-initiated roots/list). When unset,
   * the client still advertises the roots capability but reports an empty list.
   */
  workspaceRoots?: string[];
};

export type McpClient = {
  /** tools/list — missing result.tools is treated as an empty list. */
  listTools(): Promise<McpTool[]>;
  /**
   * tools/call — returns the result content flattened to text (text parts
   * joined with "\n"; non-text parts become "[<type> content]").
   * A result with isError:true rejects with code "mcp_tool_error".
   */
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  /** resources/list — missing result.resources is treated as an empty list. */
  listResources(): Promise<McpResource[]>;
  /**
   * resources/read — returns the contents flattened to text (text parts
   * joined with "\n"; blob parts become "[binary content]"), capped at
   * RESOURCE_READ_MAX_CHARS.
   */
  readResource(uri: string): Promise<string>;
  /** prompts/list — missing result.prompts is treated as an empty list. */
  listPrompts(): Promise<McpPrompt[]>;
  /**
   * prompts/get — returns the prompt's messages flattened to a single string
   * (each message rendered as "<role>: <text>", non-text parts become a
   * placeholder), capped at RESOURCE_READ_MAX_CHARS.
   */
  getPrompt(name: string, args?: Record<string, unknown>): Promise<string>;
  dispose(): void;
};

type Pending = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// npx-launched servers can take a long time to resolve/install on first start
// (slow registries/proxies) — give the one-time handshake much more room.
const HANDSHAKE_TIMEOUT_MS = 120_000;
// Latest stable MCP spec revision. Servers that only speak an older revision
// version-fallback: they reply to initialize with their own protocolVersion,
// which we accept (we do not enforce an exact match).
const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "seekforge", version: "0.3.0" };

/**
 * Client capabilities advertised in initialize. We support filesystem roots
 * (and notify on change), enabling servers to scope themselves to the
 * workspace and to issue roots/list requests back to us.
 */
const CLIENT_CAPABILITIES = { roots: { listChanged: true } } as const;

/** A read resource is capped at this many characters (text after flattening). */
export const RESOURCE_READ_MAX_CHARS = 50_000;

type ContentPart = { type: string; text?: string };
type CallToolResult = { content?: ContentPart[]; isError?: boolean };
type ResourceContent = { uri?: string; mimeType?: string; text?: string; blob?: string };
type ReadResourceResult = { contents?: ResourceContent[] };
type PromptMessage = { role?: string; content?: ContentPart | ContentPart[] };
type GetPromptResult = { description?: string; messages?: PromptMessage[] };

function flattenContent(parts: ContentPart[]): string {
  return parts
    .map((p) => (p.type === "text" ? (p.text ?? "") : `[${p.type} content]`))
    .join("\n");
}

function flattenResourceContents(contents: ResourceContent[]): string {
  return contents
    .map((c) => (typeof c.text === "string" ? c.text : `[binary content${c.mimeType ? `: ${c.mimeType}` : ""}]`))
    .join("\n");
}

/** Renders prompts/get messages to one string: "<role>: <flattened content>" per message. */
function flattenPromptMessages(messages: PromptMessage[]): string {
  return messages
    .map((m) => {
      const parts = Array.isArray(m.content) ? m.content : m.content ? [m.content] : [];
      const role = m.role ?? "user";
      return `${role}: ${flattenContent(parts)}`;
    })
    .join("\n\n");
}

/** Builds the roots/list reply payload from the configured workspace paths. */
function buildRootsResult(workspaceRoots: string[] | undefined): { roots: Array<{ uri: string; name?: string }> } {
  const roots = (workspaceRoots ?? []).map((p) => ({ uri: pathToFileURL(p).href, name: "workspace" }));
  return { roots };
}

/** Minimal transport contract shared by the stdio and Streamable HTTP backends. */
type McpTransport = {
  /** Sends one JSON-RPC request (handshaking first when needed) and returns its result. */
  request<T>(method: string, params: unknown): Promise<T>;
  dispose(): void;
};

/**
 * Newline-delimited JSON-RPC 2.0 transport for an MCP server over stdio
 * (mirrors runtime/client.ts). The child is spawned lazily; the MCP
 * initialize handshake runs once per (re)spawn before any other request.
 * A crash rejects pending requests with "mcp_crashed" and the next call
 * transparently respawns + re-handshakes.
 */
function createStdioTransport(options: McpClientOptions): McpTransport {
  const defaultTimeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let child: ChildProcessWithoutNullStreams | undefined;
  let handshake: Promise<void> | undefined;
  let pending = new Map<number, Pending>();
  let nextId = 1;
  let disposed = false;

  function ensureChild(): ChildProcessWithoutNullStreams {
    if (child) return child;
    if (disposed) throw new McpError("disposed", `MCP client "${options.name}" is disposed`);
    const command = options.config.command;
    if (!command) {
      throw new McpError("mcp_config", `MCP server "${options.name}" has neither "command" nor "url"`);
    }

    const proc = spawn(command, options.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.config.env },
    });
    child = proc;

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // not protocol output; tolerate
      }
      if (msg === null || typeof msg !== "object") return;
      const id = msg["id"];
      if (("result" in msg || "error" in msg) && typeof id === "number") {
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        clearTimeout(p.timer);
        const error = msg["error"] as { code?: number; message?: string } | undefined;
        if (error) {
          p.reject(new McpError("mcp_error", error.message ?? `MCP error ${error.code ?? ""}`.trim()));
        } else {
          p.resolve(msg["result"]);
        }
        return;
      }
      // Server-initiated requests: answer roots/list with the workspace roots.
      // Any other server request gets a JSON-RPC "method not found"; bare
      // notifications (no id) are tolerated silently.
      if (typeof msg["method"] === "string") {
        const method = msg["method"];
        if (id === undefined) return; // notification — nothing to answer
        if (method === "roots/list") {
          proc.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id, result: buildRootsResult(options.workspaceRoots) })}\n`,
            () => {},
          );
          return;
        }
        proc.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } })}\n`,
          () => {},
        );
      }
    });

    const errRl = createInterface({ input: proc.stderr });
    errRl.on("line", (line) => process.stderr.write(`[mcp:${options.name}] ${line}\n`));

    const onGone = (detail: string): void => {
      if (child !== proc) return;
      child = undefined;
      handshake = undefined;
      const stale = pending;
      pending = new Map();
      for (const p of stale.values()) {
        clearTimeout(p.timer);
        p.reject(new McpError("mcp_crashed", `MCP server "${options.name}" exited unexpectedly (${detail})`));
      }
    };
    proc.on("exit", (code, signal) => onGone(`code=${code} signal=${signal}`));
    proc.on("error", (err) => onGone(err.message));

    return proc;
  }

  function rawRequest<T>(
    proc: ChildProcessWithoutNullStreams,
    method: string,
    params: unknown,
    timeoutMs = defaultTimeout,
  ): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new McpError("mcp_timeout", `MCP server "${options.name}" did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (d: unknown) => void, reject, timer });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (err) => {
        if (err) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new McpError("mcp_write_failed", err.message));
        }
      });
    });
  }

  function notify(proc: ChildProcessWithoutNullStreams, method: string): void {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`, () => {
      /* a failed notification surfaces via the next request */
    });
  }

  /** Spawn if needed and run/await the initialize handshake exactly once per process. */
  function ensureReady(): { proc: ChildProcessWithoutNullStreams; ready: Promise<void> } {
    const proc = ensureChild();
    if (!handshake) {
      handshake = rawRequest(
        proc,
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: CLIENT_CAPABILITIES,
          clientInfo: CLIENT_INFO,
        },
        HANDSHAKE_TIMEOUT_MS,
      ).then(
        () => notify(proc, "notifications/initialized"),
        (err: Error) => {
          // Failed handshake: drop this child so the next call starts clean.
          if (child === proc) {
            child = undefined;
            handshake = undefined;
            proc.kill();
          }
          throw err;
        },
      );
    }
    return { proc, ready: handshake };
  }

  return {
    async request<T>(method: string, params: unknown): Promise<T> {
      const { proc, ready } = ensureReady();
      await ready;
      return rawRequest<T>(proc, method, params);
    },

    dispose(): void {
      disposed = true;
      handshake = undefined;
      if (child) {
        child.kill();
        child = undefined;
      }
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new McpError("disposed", `MCP client "${options.name}" disposed`));
      }
      pending.clear();
    },
  };
}

/**
 * MCP client for one configured server. The transport is selected from the
 * config: `url` present → Streamable HTTP (see http.ts), otherwise `command`
 * → stdio child process. Both transports share the request surface below
 * (initialize handshake, tools list/call, resources list/read, dispose).
 */
export function createMcpClient(options: McpClientOptions): McpClient {
  const transport: McpTransport = options.config.url
    ? createMcpHttpTransport(options)
    : createStdioTransport(options);

  return {
    async listTools(): Promise<McpTool[]> {
      // v1: no pagination (nextCursor ignored).
      const res = await transport.request<{ tools?: McpTool[] }>("tools/list", {});
      return res?.tools ?? [];
    },

    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
      const res = await transport.request<CallToolResult>("tools/call", { name, arguments: args });
      const text = flattenContent(res?.content ?? []);
      if (res?.isError) {
        throw new McpError("mcp_tool_error", text || `MCP tool ${name} reported an error`);
      }
      return text;
    },

    async listResources(): Promise<McpResource[]> {
      // v1: no pagination (nextCursor ignored), like listTools.
      const res = await transport.request<{ resources?: McpResource[] }>("resources/list", {});
      return res?.resources ?? [];
    },

    async readResource(uri: string): Promise<string> {
      const res = await transport.request<ReadResourceResult>("resources/read", { uri });
      const text = flattenResourceContents(res?.contents ?? []);
      return text.length > RESOURCE_READ_MAX_CHARS
        ? `${text.slice(0, RESOURCE_READ_MAX_CHARS)}…[truncated]`
        : text;
    },

    async listPrompts(): Promise<McpPrompt[]> {
      // v1: no pagination (nextCursor ignored), like listTools/listResources.
      const res = await transport.request<{ prompts?: McpPrompt[] }>("prompts/list", {});
      return res?.prompts ?? [];
    },

    async getPrompt(name: string, args?: Record<string, unknown>): Promise<string> {
      const res = await transport.request<GetPromptResult>("prompts/get", {
        name,
        ...(args !== undefined ? { arguments: args } : {}),
      });
      const text = flattenPromptMessages(res?.messages ?? []);
      return text.length > RESOURCE_READ_MAX_CHARS
        ? `${text.slice(0, RESOURCE_READ_MAX_CHARS)}…[truncated]`
        : text;
    },

    dispose(): void {
      transport.dispose();
    },
  };
}
