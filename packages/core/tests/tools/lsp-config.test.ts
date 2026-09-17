import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configureLspServers,
  disposeLspServers,
  lspDefinition,
  lspServerCommands,
  resolveServerCommand,
  supportedLspExtensions,
} from "../../src/tools/lsp/client.js";
import { parseLspServerConfig, resolveLspServerTable } from "../../src/tools/lsp/config.js";

// Logs every message plus the environment it was started with, and answers
// initialize and definition requests.
const LOGGING_SERVER = String.raw`#!/usr/bin/env node
import fs from "node:fs";
const log = (entry) => fs.appendFileSync(process.env.LSP_CONFIG_LOG, JSON.stringify(entry) + "\n");
log({ started: process.argv.slice(2), marker: process.env.LSP_CONFIG_MARKER ?? null });
let pending = Buffer.alloc(0);
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n"), body]));
}
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    const separator = pending.indexOf("\r\n\r\n");
    if (separator < 0) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(pending.subarray(0, separator).toString("ascii"))[1]);
    const start = separator + 4;
    if (pending.length < start + length) return;
    const message = JSON.parse(pending.subarray(start, start + length).toString("utf8"));
    pending = pending.subarray(start + length);
    log(message);
    if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
    else if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: [] });
  }
});
`;

type Logged = { started?: string[]; marker?: string | null; method?: string; params?: Record<string, unknown> };

describe("configured language servers", () => {
  let root: string;
  let workspace: string;
  let logPath: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-lsp-config-"));
    workspace = path.join(root, "workspace");
    const bin = path.join(root, "bin");
    fs.mkdirSync(workspace);
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "foo-ls"), LOGGING_SERVER, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "my-ts-ls"), LOGGING_SERVER, { mode: 0o755 });
    logPath = path.join(root, "log.jsonl");
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
    process.env.LSP_CONFIG_LOG = logPath;
  });

  afterEach(async () => {
    configureLspServers(null);
    await disposeLspServers();
    process.env.PATH = savedPath;
    delete process.env.LSP_CONFIG_LOG;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const logged = (): Logged[] =>
    fs.existsSync(logPath)
      ? fs
          .readFileSync(logPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Logged)
      : [];

  it("validates both config shapes and reports what it ignores", () => {
    expect(parseLspServerConfig({ command: "x", extensions: [".a"], languageId: "a" }).config).toEqual({
      command: "x",
      extensions: [".a"],
      languageId: "a",
    });
    expect(parseLspServerConfig({ command: "x" }).error).toMatch(/extensionToLanguage/);
    expect(parseLspServerConfig({ command: "x", extensions: [".a"] }).error).toMatch(/languageId/);
    expect(parseLspServerConfig({ command: "x", extensionToLanguage: { a: "a" } }).error).toBeDefined();
    expect(
      parseLspServerConfig({ command: "x", transport: "socket", extensionToLanguage: { ".a": "a" } }).error,
    ).toBeDefined();

    const table = resolveLspServerTable(
      {
        "p1:foo": { command: "p1", extensionToLanguage: { ".foo": "foo" } },
        "p2:foo": { command: "p2", extensionToLanguage: { ".foo": "foo", ".bar": "bar" } },
      },
      { mine: { command: "mine", extensions: [".BAR"], languageId: "bar2" }, "bad name": {}, broken: { command: "" } },
    );
    expect(table.byExtension.get(".foo")).toMatchObject({ name: "p1:foo", source: "plugin" });
    expect(table.byExtension.get(".bar")).toMatchObject({ name: "mine", source: "user", languageId: "bar2" });
    expect(table.warnings).toEqual([
      "language server p2:foo for .foo is shadowed by p1:foo",
      'lspServers: invalid server name "bad name"',
      expect.stringMatching(/^lspServers\.broken: /),
    ]);
  });

  it("starts a configured server with its args, env, languageId and initializationOptions", async () => {
    const warnings = configureLspServers({
      user: {
        foo: {
          command: "foo-ls",
          args: ["--stdio", "--flag"],
          env: { LSP_CONFIG_MARKER: "from-config" },
          extensionToLanguage: { ".foo": "foolang" },
          initializationOptions: { answer: 42 },
        },
      },
    });
    expect(warnings).toEqual([]);
    expect(supportedLspExtensions()).toContain(".foo");
    expect(lspServerCommands()).toContain("foo-ls");
    const file = path.join(workspace, "main.foo");
    fs.writeFileSync(file, "hello\n");
    await lspDefinition(workspace, file, { line: 0, character: 0 });
    const entries = logged();
    expect(entries[0]).toEqual({ started: ["--stdio", "--flag"], marker: "from-config" });
    expect(entries.find((entry) => entry.method === "initialize")?.params?.initializationOptions).toEqual({
      answer: 42,
    });
    const opened = entries.find((entry) => entry.method === "textDocument/didOpen");
    expect((opened?.params?.textDocument as { languageId?: string } | undefined)?.languageId).toBe("foolang");
  });

  it("replaces a built-in server, and keeps sessions for different servers apart", async () => {
    configureLspServers({ user: { ts: { command: "my-ts-ls", extensionToLanguage: { ".ts": "typescript" } } } });
    expect(resolveServerCommand("a.ts").candidate.command).toBe("my-ts-ls");
    const file = path.join(workspace, "a.ts");
    fs.writeFileSync(file, "export {};\n");
    await lspDefinition(workspace, file, { line: 0, character: 0 });
    configureLspServers({ user: { ts: { command: "foo-ls", extensionToLanguage: { ".ts": "typescript" } } } });
    await lspDefinition(workspace, file, { line: 0, character: 0 });
    expect(logged().filter((entry) => entry.started !== undefined)).toHaveLength(2);
  });

  it("scopes configuration to a workspace and explains a missing binary", () => {
    const other = path.join(root, "other");
    fs.mkdirSync(other);
    configureLspServers(
      { plugin: { "p:foo": { command: "foo-ls", extensionToLanguage: { ".foo": "foo" } } } },
      workspace,
    );
    configureLspServers(
      { user: { gone: { command: "not-installed-ls", extensionToLanguage: { ".foo": "foo" } } } },
      other,
    );
    expect(resolveServerCommand("x.foo", workspace).candidate.command).toBe("foo-ls");
    expect(() => resolveServerCommand("x.foo", other)).toThrow(
      /configured language server "gone" \(not-installed-ls\)/,
    );
    expect(() => resolveServerCommand("x.foo")).toThrow(/No language server is configured/);
    configureLspServers(null, workspace);
    expect(() => resolveServerCommand("x.foo", workspace)).toThrow(/No language server is configured/);
  });
});
