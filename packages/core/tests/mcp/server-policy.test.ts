/**
 * mcp-serve is a full frontend, not a side door: the user's permission rules,
 * shell hooks and OS sandbox must reach the tool calls an MCP client makes.
 * These tests drive the real dispatcher through the real JSON-RPC framing.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeSandboxCapabilities } from "../../src/tools/os-sandbox.js";
import { serveMcp, type McpServerHandle, type ServeMcpOptions } from "../../src/mcp/server.js";

type JsonRpcResponse = {
  jsonrpc: string;
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};
type ToolCallResult = { content: Array<{ type: string; text: string }>; isError: boolean };

function connect(opts: Omit<ServeMcpOptions, "input" | "output">) {
  const input = new PassThrough();
  const output = new PassThrough();
  const server: McpServerHandle = serveMcp({ ...opts, input, output });

  const pending = new Map<number, (msg: JsonRpcResponse) => void>();
  let buf = "";
  output.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line === "") continue;
      const msg = JSON.parse(line) as JsonRpcResponse;
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });

  let nextId = 1;
  const send = (method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> => {
    const id = nextId++;
    const p = new Promise<JsonRpcResponse>((resolve) => pending.set(id, resolve));
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return p;
  };

  let ready: Promise<void> | undefined;
  const call = async (name: string, args: Record<string, unknown>): Promise<ToolCallResult> => {
    ready ??= (async () => {
      await send("initialize", { protocolVersion: "2025-06-18" });
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    })();
    await ready;
    const res = await send("tools/call", { name, arguments: args });
    if (res.error) throw new Error(`${res.error.code}: ${res.error.message}`);
    return res.result as unknown as ToolCallResult;
  };
  return { server, call };
}

describe("mcp server policy wiring", () => {
  let workspace: string;
  let open: McpServerHandle[];

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-mcppolicy-"));
    open = [];
  });
  afterEach(() => {
    for (const s of open) s.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  function client(opts: Omit<ServeMcpOptions, "input" | "output" | "workspace">) {
    const c = connect({ workspace, ...opts });
    open.push(c.server);
    return c;
  }

  /** A hook script that records its payload and exits with `code`. */
  function hookScript(name: string, code: number): string {
    const path = join(workspace, name);
    writeFileSync(path, `#!/bin/sh\ncat > "${join(workspace, `${name}.payload.json`)}"\nexit ${code}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it("applies a config deny rule to a read-only call", async () => {
    writeFileSync(join(workspace, "secret.txt"), "classified\n");
    const c = client({ permissionRules: [{ action: "deny", tool: "read_file", match: "secret.txt" }] });
    const denied = await c.call("read_file", { path: "secret.txt" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toContain("denied_by_rule");
    // The rule is scoped, not a blanket refusal of the tool.
    writeFileSync(join(workspace, "public.txt"), "fine\n");
    const allowed = await c.call("read_file", { path: "public.txt" });
    expect(allowed.isError).toBe(false);
  });

  it("lets a preToolUse hook block a call and shows it the tool name", async () => {
    writeFileSync(join(workspace, "note.txt"), "hello\n");
    const script = hookScript("block.sh", 3);
    const c = client({ hooks: { preToolUse: [{ command: script }] } });
    const res = await c.call("read_file", { path: "note.txt" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("hook_blocked");
    const payload = JSON.parse(readFileSync(`${script}.payload.json`, "utf8")) as { toolName: string };
    expect(payload.toolName).toBe("read_file");
  });

  it("runs a passing preToolUse hook and then the tool", async () => {
    writeFileSync(join(workspace, "note.txt"), "hello\n");
    const c = client({ hooks: { preToolUse: [{ command: hookScript("pass.sh", 0) }] } });
    const res = await c.call("read_file", { path: "note.txt" });
    expect(res.isError).toBe(false);
    expect(res.content[0]!.text).toContain("hello");
  });

  it("auto-approves writes and commands in full mode but never an L3 env tool", async () => {
    const c = client({ readOnly: false });
    expect((await c.call("write_file", { path: "ok.txt", content: "x" })).isError).toBe(false);
    expect((await c.call("run_command", { command: "printf hi" })).isError).toBe(false);
    const env = await c.call("web_fetch", { url: "https://example.invalid/" });
    expect(env.isError).toBe(true);
    expect(env.content[0]!.text).toContain("denied_by_user");
  });

  it.runIf(probeSandboxCapabilities().available)(
    "confines run_command to the configured sandbox instead of retrying unsandboxed",
    async () => {
      const target = join(workspace, "escaped.txt");
      const c = client({ readOnly: false, sandbox: "read-only" });
      const res = await c.call("run_command", { command: `printf escaped > ${JSON.stringify(target)}` });
      // The denial reads as a plain command failure, which is exactly what the
      // unsandboxed-retry offer keys on. Nothing may accept that offer here:
      // there is no human, and an auto-yes would make the sandbox decorative.
      expect(res.isError).toBe(false); // a non-zero exit is data, not a protocol error
      const data = JSON.parse(res.content[0]!.text) as { exitCode: number };
      expect(data.exitCode).not.toBe(0);
      expect(existsSync(target)).toBe(false);
    },
  );
});
