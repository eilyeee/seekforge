import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Minimal fake MCP server for server-level tests (same pattern as
 * packages/core/tests/mcp/fixture.ts, copied — test trees must not import
 * across packages). A node script speaking newline-delimited JSON-RPC 2.0:
 * - answers the initialize handshake and requires it before anything else,
 * - tools/list → two tools: echo (with a description) and boom,
 * - resources/list → two resources (one named, one bare uri),
 * - prompts/list → two prompts (one with an argument, one bare).
 */
const FAKE_MCP_SERVER = `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
let initialized = false;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
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
      { name: "echo", description: "Echoes arguments back." },
      { name: "boom", description: "Always fails." },
    ] } });
    return;
  }
  if (msg.method === "resources/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { resources: [
      { uri: "file:///docs/readme.md", name: "readme" },
      { uri: "file:///docs/plain.txt" },
    ] } });
    return;
  }
  if (msg.method === "prompts/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { prompts: [
      { name: "greet", description: "Greet someone.", arguments: [{ name: "who", required: true }] },
      { name: "summarize" },
    ] } });
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found: " + msg.method } });
});
`;

export function writeFixtureServer(): { dir: string; serverPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "seekforge-server-mcp-"));
  const serverPath = join(dir, "fake-mcp-server.cjs");
  writeFileSync(serverPath, FAKE_MCP_SERVER);
  chmodSync(serverPath, 0o755);
  return { dir, serverPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
