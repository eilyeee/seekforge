import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  disposeLspServers,
  lspDefinition,
  lspDiagnostics,
  lspReferences,
} from "../../src/tools/lsp/client.js";

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
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
  } else if (message.method === "textDocument/definition" || message.method === "textDocument/references") {
    send({ jsonrpc: "2.0", id: message.id, result: [] });
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
  method?: string;
  params?: {
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
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
    process.env.LSP_TEST_LOG = logPath;
  });

  afterEach(async () => {
    await disposeLspServers();
    process.env.PATH = savedPath;
    if (savedLog === undefined) delete process.env.LSP_TEST_LOG;
    else process.env.LSP_TEST_LOG = savedLog;
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
  });

  it("shares one in-flight diagnostics run for concurrent callers", async () => {
    await lspDefinition(workspace, source, { line: 0, character: 0 });

    const results = await withTimeout(
      Promise.all([lspDiagnostics(workspace, source), lspDiagnostics(workspace, source)]),
      500,
    );

    expect(results).toEqual([
      [expect.objectContaining({ message: "version-2" })],
      [expect.objectContaining({ message: "version-2" })],
    ]);
    const changes = messages().filter((message) => message.method === "textDocument/didChange");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.params?.textDocument?.version).toBe(2);
  });
});
