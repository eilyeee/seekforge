import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Fake MCP server: a node script speaking newline-delimited JSON-RPC 2.0.
 * - Enforces the initialize handshake: any request before the
 *   notifications/initialized notification is answered with an error,
 *   so passing tests prove handshake-before-first-call ordering.
 * - Exits with code 9 if initialize arrives twice in one process
 *   (concurrent callers must share one cached handshake).
 * - tools/list → two tools: echo (with an inputSchema) and boom.
 * - tools/call echo → echoes args as text + one non-text part.
 * - tools/call boom → isError:true result.
 * - tools/call die  → process.exit(7) without answering.
 */
const FAKE_MCP_SERVER = `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
let initRequested = false;
let initialized = false;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    if (initRequested) process.exit(9);
    initRequested = true;
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-mcp", version: "0.0.1" },
    } });
    return;
  }
  if (msg.method === "notifications/initialized") { initialized = true; return; }
  if (msg.id === undefined) return;
  if (!initialized) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32002, message: "not initialized" } });
    return;
  }
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "echo", description: "Echoes arguments back.\\nSecond line of docs.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      { name: "boom", description: "Always fails." },
    ] } });
    return;
  }
  if (msg.method === "tools/call") {
    const name = msg.params.name;
    if (name === "die") process.exit(7);
    if (name === "boom") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "kaboom" }], isError: true } });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [
      { type: "text", text: "echo:" + JSON.stringify(msg.params.arguments) },
      { type: "image", data: "deadbeef", mimeType: "image/png" },
    ] } });
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found: " + msg.method } });
});
`;

export function writeFixtureServer(): { dir: string; serverPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "seekforge-mcp-"));
  const serverPath = join(dir, "fake-mcp-server.cjs");
  writeFileSync(serverPath, FAKE_MCP_SERVER);
  chmodSync(serverPath, 0o755);
  return { dir, serverPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
