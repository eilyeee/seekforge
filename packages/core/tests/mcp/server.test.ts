import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MCP_READONLY_TOOLS, serveMcp, type McpServerHandle } from "../../src/mcp/server.js";

type JsonRpcResponse = {
  jsonrpc: string;
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

/** In-memory transport: send a request line, await the matching response line. */
function connect(workspace: string, readOnly?: boolean) {
  const input = new PassThrough();
  const output = new PassThrough();
  const server: McpServerHandle = serveMcp({ workspace, readOnly, input, output });

  const pending = new Map<number, (msg: JsonRpcResponse) => void>();
  const unsolicited: JsonRpcResponse[] = [];
  let buf = "";
  output.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line === "") continue;
      const msg = JSON.parse(line) as JsonRpcResponse;
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      } else {
        unsolicited.push(msg);
      }
    }
  });

  let nextId = 1;
  const request = (method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> => {
    const id = nextId++;
    const p = new Promise<JsonRpcResponse>((resolve) => pending.set(id, resolve));
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return p;
  };
  const notify = (method: string): void => {
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  };
  return { server, request, notify, unsolicited };
}

describe("mcp server", () => {
  let workspace: string;
  let open: McpServerHandle[];
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-mcpsrv-"));
    open = [];
  });
  afterEach(() => {
    for (const s of open) s.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  function client(readOnly?: boolean) {
    const c = connect(workspace, readOnly);
    open.push(c.server);
    return c;
  }

  it("answers initialize and swallows notifications/initialized", async () => {
    const c = client();
    const res = await c.request("initialize", { protocolVersion: "2024-11-05" });
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({
      // The server declares its own supported version (kept in lockstep with our
      // client's PROTOCOL_VERSION), not necessarily the one the caller requested.
      protocolVersion: "2025-06-18",
      serverInfo: { name: "seekforge" },
      capabilities: { tools: {} },
    });
    c.notify("notifications/initialized");
    // A follow-up request still works and nothing was emitted for the notification.
    const ping = await c.request("ping");
    expect(ping.result).toEqual({});
    expect(c.unsolicited).toEqual([]);
  });

  it("tools/list in read-only mode advertises exactly the read-only subset", async () => {
    const c = client(); // readOnly is the DEFAULT
    const res = await c.request("tools/list");
    const tools = res.result!["tools"] as Array<{ name: string; inputSchema: unknown }>;
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_READONLY_TOOLS].sort());
    expect(tools[0]!.inputSchema).toMatchObject({ type: "object" });
  });

  it("tools/list in full mode adds write/execute tools but never ask_user", async () => {
    const c = client(false);
    const res = await c.request("tools/list");
    const names = (res.result!["tools"] as Array<{ name: string }>).map((t) => t.name);
    for (const t of MCP_READONLY_TOOLS) expect(names).toContain(t);
    expect(names).toContain("write_file");
    expect(names).toContain("run_command");
    expect(names).not.toContain("ask_user");
  });

  it("tools/call read_file returns file content", async () => {
    writeFileSync(join(workspace, "hello.txt"), "hi from mcp\n");
    const c = client();
    const res = await c.request("tools/call", { name: "read_file", arguments: { path: "hello.txt" } });
    expect(res.error).toBeUndefined();
    const result = res.result as { content: Array<{ type: string; text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toContain("hi from mcp");
  });

  it("denies writes in read-only mode (tool not exposed)", async () => {
    const c = client();
    const res = await c.request("tools/call", {
      name: "write_file",
      arguments: { path: "evil.txt", content: "nope" },
    });
    expect(res.result).toBeUndefined();
    expect(res.error!.code).toBe(-32602);
    expect(res.error!.message).toContain("read-only");
  });

  it("allows writes in full mode (confirm auto-approves L1)", async () => {
    const c = client(false);
    const res = await c.request("tools/call", {
      name: "write_file",
      arguments: { path: "ok.txt", content: "written via mcp" },
    });
    expect(res.error).toBeUndefined();
    const result = res.result as { isError: boolean };
    expect(result.isError).toBe(false);
  });

  it("resources/list is empty and unknown methods get -32601", async () => {
    const c = client();
    const resources = await c.request("resources/list");
    expect(resources.result).toEqual({ resources: [] });
    const unknown = await c.request("prompts/list");
    expect(unknown.error).toMatchObject({ code: -32601 });
    expect(unknown.error!.message).toContain("prompts/list");
  });

  it("reports a tool failure as isError content, not a protocol error", async () => {
    mkdirSync(join(workspace, "sub"));
    const c = client();
    const res = await c.request("tools/call", { name: "read_file", arguments: { path: "missing.txt" } });
    expect(res.error).toBeUndefined(); // JSON-RPC level is fine
    const result = res.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.length).toBeGreaterThan(0);
  });
});
