import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acquireLspServerLease,
  disposeLspServers,
  lspDefinition,
  lspDiagnostics,
  lspReferences,
} from "../../src/tools/lsp/client.js";

// A language server that ignores SIGTERM and stays alive after stdin closes, so
// only a SIGKILL escalation can take it down. Writes its pid for observation.
const STUBBORN_SERVER = String.raw`#!/usr/bin/env node
import fs from "node:fs";

process.on("SIGTERM", () => {}); // ignore graceful shutdown
if (process.env.STUBBORN_PID_FILE) fs.writeFileSync(process.env.STUBBORN_PID_FILE, String(process.pid));
setInterval(() => {}, 1 << 30); // stay alive even once stdin reaches EOF

let pending = Buffer.alloc(0);
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n"), body]));
}
function handle(message) {
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
  else if (message.method === "textDocument/definition" || message.method === "textDocument/references")
    send({ jsonrpc: "2.0", id: message.id, result: [] });
}
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    const separator = pending.indexOf("\r\n\r\n");
    if (separator < 0) return;
    const header = pending.subarray(0, separator).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) { pending = pending.subarray(separator + 4); continue; }
    const length = Number(match[1]);
    const start = separator + 4;
    if (pending.length < start + length) return;
    const message = JSON.parse(pending.subarray(start, start + length).toString("utf8"));
    pending = pending.subarray(start + length);
    handle(message);
  }
});
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const FAKE_SERVER = String.raw`#!/usr/bin/env node
import fs from "node:fs";

let pending = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(Buffer.concat([
    Buffer.from("Content-Length: " + body.length + "\r\n\r\n"),
    body,
  ]));
}

function publish(params) {
  if (process.env.LSP_TEST_HOLD_DIAGNOSTICS === "1") return;
  if (process.env.LSP_TEST_EXIT_ON_DIAGNOSTICS === "1") {
    setTimeout(() => process.exit(23), 10);
    return;
  }
  setTimeout(() => send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri: params.textDocument.uri,
      version: params.textDocument.version,
      diagnostics: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 2,
        message: "version-" + params.textDocument.version,
      }],
    },
  }), 25);
}

function handle(message) {
  fs.appendFileSync(process.env.LSP_TEST_LOG, JSON.stringify(message) + "\n");
  if (message.method === "initialize") {
    const respond = () => send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
    if (process.env.LSP_TEST_DELAY_INITIALIZE === "1") setTimeout(respond, 75);
    else respond();
  } else if (message.method === "textDocument/definition" || message.method === "textDocument/references") {
    if (process.env.LSP_TEST_HOLD_REQUESTS !== "1") {
      send({ jsonrpc: "2.0", id: message.id, result: [] });
    }
  } else if (message.method === "textDocument/didOpen") {
    publish({ textDocument: message.params.textDocument });
  } else if (message.method === "textDocument/didChange") {
    publish(message.params);
  }
}

process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    const separator = pending.indexOf("\r\n\r\n");
    if (separator < 0) return;
    const header = pending.subarray(0, separator).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      pending = pending.subarray(separator + 4);
      continue;
    }
    const length = Number(match[1]);
    const start = separator + 4;
    if (pending.length < start + length) return;
    const message = JSON.parse(pending.subarray(start, start + length).toString("utf8"));
    pending = pending.subarray(start + length);
    handle(message);
  }
});
`;

type LspMessage = {
  id?: number;
  method?: string;
  params?: {
    id?: number;
    textDocument?: { version?: number; text?: string };
    contentChanges?: Array<{ text?: string }>;
  };
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("concurrent diagnostics hung")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("lsp document synchronization", () => {
  let root: string;
  let workspace: string;
  let source: string;
  let logPath: string;
  let savedPath: string | undefined;
  let savedLog: string | undefined;
  let savedHoldRequests: string | undefined;
  let savedHoldDiagnostics: string | undefined;
  let savedExitOnDiagnostics: string | undefined;
  let savedDelayInitialize: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-lsp-session-"));
    workspace = path.join(root, "workspace");
    const bin = path.join(root, "bin");
    fs.mkdirSync(workspace);
    fs.mkdirSync(bin);
    source = path.join(workspace, "app.ts");
    logPath = path.join(root, "messages.jsonl");
    fs.writeFileSync(source, "export const value = 1;\n");
    const serverPath = path.join(bin, "typescript-language-server");
    fs.writeFileSync(serverPath, FAKE_SERVER, { mode: 0o755 });

    savedPath = process.env.PATH;
    savedLog = process.env.LSP_TEST_LOG;
    savedHoldRequests = process.env.LSP_TEST_HOLD_REQUESTS;
    savedHoldDiagnostics = process.env.LSP_TEST_HOLD_DIAGNOSTICS;
    savedExitOnDiagnostics = process.env.LSP_TEST_EXIT_ON_DIAGNOSTICS;
    savedDelayInitialize = process.env.LSP_TEST_DELAY_INITIALIZE;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
    process.env.LSP_TEST_LOG = logPath;
  });

  afterEach(async () => {
    await disposeLspServers();
    process.env.PATH = savedPath;
    if (savedLog === undefined) delete process.env.LSP_TEST_LOG;
    else process.env.LSP_TEST_LOG = savedLog;
    restoreEnv("LSP_TEST_HOLD_REQUESTS", savedHoldRequests);
    restoreEnv("LSP_TEST_HOLD_DIAGNOSTICS", savedHoldDiagnostics);
    restoreEnv("LSP_TEST_EXIT_ON_DIAGNOSTICS", savedExitOnDiagnostics);
    restoreEnv("LSP_TEST_DELAY_INITIALIZE", savedDelayInitialize);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function messages(): LspMessage[] {
    return fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LspMessage);
  }

  async function waitForMessage(method: string): Promise<LspMessage> {
    // Full-suite workers contend for process startup and filesystem I/O; this
    // helper is synchronization, not the behavior timeout under test.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const found = fs.existsSync(logPath) ? messages().find((message) => message.method === method) : undefined;
      if (found) return found;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${method}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("sends didChange with current contents before definition and references", async () => {
    await lspDefinition(workspace, source, { line: 0, character: 0 });

    fs.writeFileSync(source, "export const value = 2;\n");
    await lspDefinition(workspace, source, { line: 0, character: 0 });

    fs.writeFileSync(source, "export const value = 3;\n");
    await lspReferences(workspace, source, { line: 0, character: 0 });

    const relevant = messages().filter((message) =>
      ["textDocument/didOpen", "textDocument/didChange", "textDocument/definition", "textDocument/references"].includes(
        message.method ?? "",
      ),
    );
    expect(relevant.map((message) => message.method)).toEqual([
      "textDocument/didOpen",
      "textDocument/definition",
      "textDocument/didChange",
      "textDocument/definition",
      "textDocument/didChange",
      "textDocument/references",
    ]);
    expect(relevant[2]?.params?.textDocument?.version).toBe(2);
    expect(relevant[2]?.params?.contentChanges?.[0]?.text).toBe("export const value = 2;\n");
    expect(relevant[4]?.params?.textDocument?.version).toBe(3);
    expect(relevant[4]?.params?.contentChanges?.[0]?.text).toBe("export const value = 3;\n");
  }, 15_000);

  it("shares one in-flight diagnostics run for concurrent callers", async () => {
    await lspDefinition(workspace, source, { line: 0, character: 0 });

    const results = await withTimeout(
      Promise.all([lspDiagnostics(workspace, source), lspDiagnostics(workspace, source)]),
      3_000,
    );

    expect(results).toEqual([
      [expect.objectContaining({ message: "version-2" })],
      [expect.objectContaining({ message: "version-2" })],
    ]);
    const changes = messages().filter((message) => message.method === "textDocument/didChange");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.params?.textDocument?.version).toBe(2);
  });

  it("cancels an in-flight request when its AbortSignal fires", async () => {
    process.env.LSP_TEST_HOLD_REQUESTS = "1";
    const controller = new AbortController();
    const request = lspDefinition(workspace, source, { line: 0, character: 0 }, controller.signal);
    const sent = await waitForMessage("textDocument/definition");

    controller.abort();

    await expect(request).rejects.toMatchObject({ code: "cancelled" });
    const cancellation = await waitForMessage("$/cancelRequest");
    expect(cancellation.params?.id).toBe(sent.id);
  });

  it("does not let one caller abort shared session initialization", async () => {
    process.env.LSP_TEST_DELAY_INITIALIZE = "1";
    const controller = new AbortController();
    const first = lspDefinition(workspace, source, { line: 0, character: 0 }, controller.signal);
    await waitForMessage("initialize");
    const second = lspReferences(workspace, source, { line: 0, character: 0 });

    controller.abort();

    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    await expect(second).resolves.toEqual([]);
    expect(messages().filter((message) => message.method === "initialize")).toHaveLength(1);
  });

  it("rejects a diagnostics wait when the server exits", async () => {
    process.env.LSP_TEST_EXIT_ON_DIAGNOSTICS = "1";

    await expect(lspDiagnostics(workspace, source)).rejects.toMatchObject({ code: "lsp_exited" });
  });

  it("rejects a diagnostics wait when the session is disposed", async () => {
    process.env.LSP_TEST_HOLD_DIAGNOSTICS = "1";
    const diagnostics = lspDiagnostics(workspace, source);
    await waitForMessage("textDocument/didOpen");

    await disposeLspServers();

    await expect(diagnostics).rejects.toMatchObject({ code: "lsp_exited" });
  });

  it("stops waiting for diagnostics when its AbortSignal fires", async () => {
    process.env.LSP_TEST_HOLD_DIAGNOSTICS = "1";
    const controller = new AbortController();
    const diagnostics = lspDiagnostics(workspace, source, controller.signal);
    await waitForMessage("textDocument/didOpen");

    controller.abort();

    await expect(diagnostics).rejects.toMatchObject({ code: "cancelled" });
  });

  it("escalates to SIGKILL when the server ignores SIGTERM on dispose", async () => {
    const serverPath = path.join(root, "bin", "typescript-language-server");
    const pidFile = path.join(root, "stubborn.pid");
    fs.writeFileSync(serverPath, STUBBORN_SERVER, { mode: 0o755 });
    const savedPidEnv = process.env.STUBBORN_PID_FILE;
    process.env.STUBBORN_PID_FILE = pidFile;
    try {
      // Spawn + handshake a live session against the stubborn server.
      await lspDefinition(workspace, source, { line: 0, character: 0 });
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      expect(isAlive(pid)).toBe(true);

      // dispose() ends stdin + sends SIGTERM (ignored) and schedules a SIGKILL
      // after the grace window. Fast-forward that timer rather than waiting it out.
      vi.useFakeTimers();
      try {
        const disposed = disposeLspServers();
        await vi.advanceTimersByTimeAsync(0); // let dispose() schedule the force-kill
        expect(isAlive(pid)).toBe(true); // SIGTERM ignored — still alive
        vi.advanceTimersByTime(5_000); // DISPOSE_GRACE_MS: escalate to SIGKILL
        await disposed;
      } finally {
        vi.useRealTimers();
      }

      const deadline = Date.now() + 5_000;
      while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(isAlive(pid)).toBe(false);
    } finally {
      if (savedPidEnv === undefined) delete process.env.STUBBORN_PID_FILE;
      else process.env.STUBBORN_PID_FILE = savedPidEnv;
    }
  }, 20_000);

  it("keeps workspace sessions alive until the final run lease releases", async () => {
    const first = acquireLspServerLease(workspace);
    const second = acquireLspServerLease(workspace);
    await lspDefinition(workspace, source, { line: 0, character: 0 });

    await first.release();
    await lspReferences(workspace, source, { line: 0, character: 0 });

    expect(messages().filter((message) => message.method === "initialize")).toHaveLength(1);
    await second.release();
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
