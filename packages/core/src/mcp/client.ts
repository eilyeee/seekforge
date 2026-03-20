import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { McpServerConfig, McpTool } from "./types.js";

/** Error thrown for MCP transport/protocol failures. */
export class McpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export type McpClientOptions = {
  /** Server name (config key) — used in log prefixes and error messages. */
  name: string;
  config: McpServerConfig;
  /** Default per-request timeout. */
  requestTimeoutMs?: number;
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
  dispose(): void;
};

type Pending = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "seekforge", version: "0.3.0" };

type ContentPart = { type: string; text?: string };
type CallToolResult = { content?: ContentPart[]; isError?: boolean };

function flattenContent(parts: ContentPart[]): string {
  return parts
    .map((p) => (p.type === "text" ? (p.text ?? "") : `[${p.type} content]`))
    .join("\n");
}

/**
 * Newline-delimited JSON-RPC 2.0 client for an MCP server over stdio
 * (mirrors runtime/client.ts). The child is spawned lazily; the MCP
 * initialize handshake runs once per (re)spawn before any other request.
 * A crash rejects pending requests with "mcp_crashed" and the next call
 * transparently respawns + re-handshakes.
 */
export function createMcpClient(options: McpClientOptions): McpClient {
  const defaultTimeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let child: ChildProcessWithoutNullStreams | undefined;
  let handshake: Promise<void> | undefined;
  let pending = new Map<number, Pending>();
  let nextId = 1;
  let disposed = false;

  function ensureChild(): ChildProcessWithoutNullStreams {
    if (child) return child;
    if (disposed) throw new McpError("disposed", `MCP client "${options.name}" is disposed`);

    const proc = spawn(options.config.command, options.config.args ?? [], {
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
      // Server-initiated requests/notifications are not supported in v1.
      if (typeof msg["method"] === "string") {
        process.stderr.write(`[mcp:${options.name}] ignoring server message: ${msg["method"]}\n`);
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

  function rawRequest<T>(proc: ChildProcessWithoutNullStreams, method: string, params: unknown): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new McpError("mcp_timeout", `MCP server "${options.name}" did not answer ${method} within ${defaultTimeout}ms`));
      }, defaultTimeout);
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
      handshake = rawRequest(proc, "initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      }).then(
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

  async function call<T>(method: string, params: unknown): Promise<T> {
    const { proc, ready } = ensureReady();
    await ready;
    return rawRequest<T>(proc, method, params);
  }

  return {
    async listTools(): Promise<McpTool[]> {
      // v1: no pagination (nextCursor ignored).
      const res = await call<{ tools?: McpTool[] }>("tools/list", {});
      return res?.tools ?? [];
    },

    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
      const res = await call<CallToolResult>("tools/call", { name, arguments: args });
      const text = flattenContent(res?.content ?? []);
      if (res?.isError) {
        throw new McpError("mcp_tool_error", text || `MCP tool ${name} reported an error`);
      }
      return text;
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
