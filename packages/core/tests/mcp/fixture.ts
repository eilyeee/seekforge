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
 * - resources/list → two resources: mem://notes (named) and mem://logo.
 * - resources/read mem://notes → one text part; mem://logo → one blob part;
 *   mem://big → 60_000 chars of text (cap testing); others → error.
 * - On initialize it records the client's advertised protocolVersion and
 *   capabilities, echoes the SAME protocolVersion back (so the negotiated
 *   value is observable), and — after notifications/initialized — issues a
 *   server→client roots/list request (id "srv-1"); the client's answer is
 *   captured and exposed via tools/call __getRoots.
 * - prompts/list → two prompts: greet (with an argument) and review.
 * - prompts/get greet → two messages (system + user) rendering the name arg;
 *   prompts/get big → one 60_000-char message (cap testing); others → error.
 */
const FAKE_MCP_SERVER = `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
let initRequested = false;
let initialized = false;
let clientProtocolVersion = null;
let clientCapabilities = null;
let rootsAnswer = null;
const slowCalls = new Map();
const cancelledRequests = [];
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  // The client's answer to our server→client roots/list request.
  if (msg.id === "srv-1" && (msg.result !== undefined || msg.error !== undefined)) {
    rootsAnswer = msg.result || { error: msg.error };
    return;
  }
  if (msg.method === "initialize") {
    if (initRequested) process.exit(9);
    initRequested = true;
    clientProtocolVersion = msg.params && msg.params.protocolVersion;
    clientCapabilities = (msg.params && msg.params.capabilities) || null;
    send({ jsonrpc: "2.0", id: msg.id, result: {
      // Echo the client's version back: a compliant server negotiates down to
      // a version it supports; here we accept whatever the client offers.
      protocolVersion: clientProtocolVersion,
      capabilities: { tools: {}, prompts: {} },
      serverInfo: { name: "fake-mcp", version: "0.0.1" },
    } });
    return;
  }
  if (msg.method === "notifications/initialized") {
    initialized = true;
    // Server-initiated request: ask the client for its roots.
    send({ jsonrpc: "2.0", id: "srv-1", method: "roots/list", params: {} });
    return;
  }
  if (msg.method === "notifications/cancelled") {
    const requestId = msg.params && msg.params.requestId;
    cancelledRequests.push(requestId);
    const timer = slowCalls.get(requestId);
    if (timer) { clearTimeout(timer); slowCalls.delete(requestId); }
    return;
  }
  if (msg.id === undefined) return;
  if (!initialized) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32002, message: "not initialized" } });
    return;
  }
  if (msg.method === "prompts/list") {
    const cursor = msg.params && msg.params.cursor;
    send({ jsonrpc: "2.0", id: msg.id, result: cursor === "prompts-2"
      ? { prompts: [{ name: "review", description: "Reviews code." }] }
      : { prompts: [{ name: "greet", description: "Greets someone.",
          arguments: [{ name: "name", description: "Who to greet", required: true }] }], nextCursor: "prompts-2" } });
    return;
  }
  if (msg.method === "prompts/get") {
    const name = msg.params.name;
    const args = msg.params.arguments || {};
    if (name === "greet") {
      send({ jsonrpc: "2.0", id: msg.id, result: { description: "Greets someone.", messages: [
        { role: "system", content: { type: "text", text: "Be friendly." } },
        { role: "user", content: { type: "text", text: "Hello " + (args.name || "world") } },
      ] } });
      return;
    }
    if (name === "big") {
      send({ jsonrpc: "2.0", id: msg.id, result: { messages: [
        { role: "user", content: { type: "text", text: "x".repeat(60000) } },
      ] } });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown prompt: " + name } });
    return;
  }
  if (msg.method === "tools/call" && msg.params.name === "__getRoots") {
    // Wait until the client has answered our server→client roots/list (it may
    // still be in flight when this call arrives), then report what we saw.
    const reply = () => send({ jsonrpc: "2.0", id: msg.id, result: { content: [
      { type: "text", text: JSON.stringify({ protocolVersion: clientProtocolVersion, capabilities: clientCapabilities, rootsAnswer }) },
    ] } });
    if (rootsAnswer !== null) { reply(); return; }
    const wait = setInterval(() => { if (rootsAnswer !== null) { clearInterval(wait); reply(); } }, 5);
    return;
  }
  if (msg.method === "tools/call" && msg.params.name === "__getCancelled") {
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [
      { type: "text", text: JSON.stringify(cancelledRequests) },
    ] } });
    return;
  }
  if (msg.method === "tools/list") {
    const cursor = msg.params && msg.params.cursor;
    const hasCursor = msg.params && Object.prototype.hasOwnProperty.call(msg.params, "cursor");
    send({ jsonrpc: "2.0", id: msg.id, result: hasCursor && cursor === ""
      ? { tools: [{ name: "boom", description: "Always fails." }] }
      : { tools: [{ name: "echo", description: "Echoes arguments back.\\nSecond line of docs.",
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }], nextCursor: "" } });
    return;
  }
  if (msg.method === "resources/list") {
    const cursor = msg.params && msg.params.cursor;
    send({ jsonrpc: "2.0", id: msg.id, result: cursor === "resources-2"
      ? { resources: [{ uri: "mem://logo" }] }
      : { resources: [{ uri: "mem://notes", name: "Notes", mimeType: "text/plain" }], nextCursor: "resources-2" } });
    return;
  }
  if (msg.method === "resources/read") {
    const uri = msg.params.uri;
    if (uri === "mem://notes") {
      send({ jsonrpc: "2.0", id: msg.id, result: { contents: [
        { uri, mimeType: "text/plain", text: "note one\\nnote two" },
      ] } });
      return;
    }
    if (uri === "mem://logo") {
      send({ jsonrpc: "2.0", id: msg.id, result: { contents: [
        { uri, mimeType: "image/png", blob: "deadbeef" },
      ] } });
      return;
    }
    if (uri === "mem://big") {
      send({ jsonrpc: "2.0", id: msg.id, result: { contents: [
        { uri, mimeType: "text/plain", text: "x".repeat(60000) },
      ] } });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32002, message: "unknown resource: " + uri } });
    return;
  }
  if (msg.method === "tools/call") {
    const name = msg.params.name;
    if (name === "die") process.exit(7);
    if (name === "slow") {
      const timer = setTimeout(() => {
        slowCalls.delete(msg.id);
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "too late" }] } });
      }, 5000);
      slowCalls.set(msg.id, timer);
      return;
    }
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

/**
 * Minimal server that ONLY speaks the older 2024-11-05 revision: it replies to
 * initialize with that fixed protocolVersion regardless of what the client
 * offered (version-fallback). Used to prove the handshake still connects.
 */
const FALLBACK_MCP_SERVER = `#!/usr/bin/env node
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
      serverInfo: { name: "old-mcp", version: "0.0.1" },
    } });
    return;
  }
  if (msg.method === "notifications/initialized") { initialized = true; return; }
  if (msg.id === undefined) return;
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", description: "pong" }] } });
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

/** Writes the 2024-11-05-only server for version-fallback handshake tests. */
export function writeFallbackServer(): { dir: string; serverPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "seekforge-mcp-old-"));
  const serverPath = join(dir, "old-mcp-server.cjs");
  writeFileSync(serverPath, FALLBACK_MCP_SERVER);
  chmodSync(serverPath, 0o755);
  return { dir, serverPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
