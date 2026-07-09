/**
 * Minimal Language Server Protocol (LSP) client, used by the optional `lsp_*`
 * tools to get PRECISE symbol information (definitions, references, diagnostics)
 * from a real language server — the compiler's own view, not a lexical guess.
 *
 * Like the browser tools, a language server is an EXTERNAL, OPTIONAL, heavy
 * dependency the user installs themselves (`typescript-language-server`,
 * `pyright-langserver`, `gopls`, …). Nothing here is a declared dependency: we
 * detect the server binary on PATH and, when it is absent, every tool returns a
 * clear, actionable "install a language server" error instead of crashing. The
 * server binary is spawned lazily, so typecheck/build/tests never need one.
 *
 * The wire framing (`encodeLspMessage` / `parseLspMessages`) is kept PURE and
 * side-effect-free so it can be unit-tested without spawning anything.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ToolError } from "../errors.js";

// ---------------------------------------------------------------------------
// Pure JSON-RPC framing (Content-Length header + JSON body). No IO here.
// ---------------------------------------------------------------------------

/** Encode a JSON-RPC message as an LSP `Content-Length`-framed buffer. */
export function encodeLspMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  // Content-Length counts BYTES of the body, not characters.
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

export type ParseResult = {
  /** Fully-received, JSON-parsed messages, in order. */
  messages: unknown[];
  /** Leftover bytes: an incomplete trailing message awaiting more data. */
  rest: Buffer;
};

/**
 * Parse zero or more framed messages out of a byte buffer.
 *
 * Handles the three realities of a streamed transport:
 *   - MULTIPLE messages concatenated in one buffer → all are returned.
 *   - a PARTIAL message (header or body not fully arrived) → left in `rest`
 *     so the caller can prepend the next chunk and re-parse.
 *   - a MALFORMED header block (no `Content-Length`) → skipped past to resync,
 *     so one bad frame cannot wedge the stream forever.
 */
/**
 * Upper bound on a single message body. A well-behaved server never approaches
 * this; a garbage/malicious `Content-Length` (or one that never completes) would
 * otherwise grow the receive buffer without bound and OOM the process.
 */
export const MAX_CONTENT_LENGTH = 64 * 1024 * 1024;

export function parseLspMessages(buffer: Buffer): ParseResult {
  const messages: unknown[] = [];
  let buf = buffer;
  for (;;) {
    const sep = buf.indexOf("\r\n\r\n");
    if (sep === -1) break; // header not fully received yet — wait for more.
    const header = buf.subarray(0, sep).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      // Malformed header (no Content-Length): drop it and the separator, resync.
      buf = buf.subarray(sep + 4);
      continue;
    }
    const length = Number(match[1]);
    if (!Number.isInteger(length) || length < 0 || length > MAX_CONTENT_LENGTH) {
      // Absurd/garbage Content-Length: drop this frame and resync rather than
      // wait forever for a body that will never (sanely) arrive.
      buf = buf.subarray(sep + 4);
      continue;
    }
    const bodyStart = sep + 4;
    if (buf.length < bodyStart + length) break; // body still arriving — wait.
    const body = buf.subarray(bodyStart, bodyStart + length).toString("utf8");
    try {
      messages.push(JSON.parse(body));
    } catch {
      // Advance past an unparseable body rather than loop forever on it.
    }
    buf = buf.subarray(bodyStart + length);
  }
  return { messages, rest: buf };
}

// ---------------------------------------------------------------------------
// Language → server-command mapping and PATH detection.
// ---------------------------------------------------------------------------

type Candidate = { command: string; args: string[] };
type LangEntry = {
  /** LSP languageId sent in textDocument/didOpen. */
  languageId: string;
  /** Server binaries to try, in order; the first found on PATH wins. */
  servers: Candidate[];
  /** Actionable install hint naming the common servers for this language. */
  install: string;
};

const STDIO = ["--stdio"];

const EXT_TO_LANG: Record<string, LangEntry> = {
  ".ts": tsEntry("typescript"),
  ".tsx": tsEntry("typescriptreact"),
  ".mts": tsEntry("typescript"),
  ".cts": tsEntry("typescript"),
  ".js": tsEntry("javascript"),
  ".jsx": tsEntry("javascriptreact"),
  ".mjs": tsEntry("javascript"),
  ".cjs": tsEntry("javascript"),
  ".py": {
    languageId: "python",
    // pyright-langserver --stdio, else pylsp (which speaks stdio by default).
    servers: [
      { command: "pyright-langserver", args: STDIO },
      { command: "pylsp", args: [] },
    ],
    install:
      "Install a Python language server: `pip install pyright` (pyright-langserver) or `pip install python-lsp-server` (pylsp).",
  },
  ".go": {
    languageId: "go",
    servers: [{ command: "gopls", args: [] }],
    install: "Install the Go language server: `go install golang.org/x/tools/gopls@latest` (needs Go on PATH).",
  },
};

function tsEntry(languageId: string): LangEntry {
  return {
    languageId,
    servers: [{ command: "typescript-language-server", args: STDIO }],
    install:
      "Install the TypeScript/JavaScript language server: `npm i -g typescript-language-server typescript`.",
  };
}

/** True if `command` resolves to an executable on PATH (or is an existing path). */
export function commandExistsOnPath(command: string): boolean {
  if (command.includes(path.sep)) {
    try {
      return fs.existsSync(command);
    } catch {
      return false;
    }
  }
  const rawPath = process.env.PATH ?? "";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const dir of rawPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, command + ext))) return true;
      } catch {
        // ignore an unreadable PATH entry
      }
    }
  }
  return false;
}

type Resolved = { languageId: string; candidate: Candidate };

/**
 * Resolve the server to run for a file, or throw an actionable ToolError:
 *   - `lsp_unsupported` when the extension has no known server, and
 *   - `lsp_unavailable` (with the per-language install hint) when a server IS
 *     known but none of its binaries are found on PATH.
 * This is where graceful degradation happens — no process is spawned here.
 */
export function resolveServerCommand(filePath: string): Resolved {
  const ext = path.extname(filePath).toLowerCase();
  const entry = EXT_TO_LANG[ext];
  if (!entry) {
    throw new ToolError(
      "lsp_unsupported",
      `No language server is configured for "${ext || filePath}". ` +
        "Supported: .ts/.tsx/.js/.jsx (typescript-language-server), .py (pyright/pylsp), .go (gopls).",
    );
  }
  const candidate = entry.servers.find((s) => commandExistsOnPath(s.command));
  if (!candidate) {
    throw new ToolError("lsp_unavailable", entry.install);
  }
  return { languageId: entry.languageId, candidate };
}

// ---------------------------------------------------------------------------
// LSP position / result types (only the slice we use).
// ---------------------------------------------------------------------------

/** 0-based line/character, per the LSP spec. */
export type LspPosition = { line: number; character: number };
type LspRange = { start: LspPosition; end: LspPosition };
type LspLocation = { uri: string; range: LspRange };
type LspLocationLink = { targetUri: string; targetRange: LspRange };
export type LspDiagnostic = {
  range: LspRange;
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
};

const SEVERITY: Record<number, string> = { 1: "error", 2: "warning", 3: "information", 4: "hint" };

export function severityLabel(severity?: number): string {
  return severity != null && SEVERITY[severity] ? SEVERITY[severity] : "info";
}

// ---------------------------------------------------------------------------
// Session: one long-lived server process per languageId + workspace.
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;
const DIAGNOSTICS_WAIT_MS = 4_000;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

class LspSession {
  readonly workspace: string;
  private readonly languageId: string;
  private readonly candidate: Candidate;
  private child: ChildProcess | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly opened = new Map<string, number>(); // uri → document version
  private readonly diagnostics = new Map<string, LspDiagnostic[]>();
  private readonly diagWaiters = new Map<string, () => void>();
  // uri → the document version we last asked diagnostics for, so a stale
  // publishDiagnostics for an older version can be ignored.
  private readonly diagExpected = new Map<string, number>();
  private disposed = false;
  // Set once the child process errors or exits. A session in this state can
  // never serve another request, so the registry must discard it (not reuse
  // the cached-but-dead process, which would hang every call until timeout).
  private ended = false;

  constructor(workspace: string, languageId: string, candidate: Candidate) {
    this.workspace = workspace;
    this.languageId = languageId;
    this.candidate = candidate;
  }

  /** False once the underlying server has exited/errored or been disposed. */
  get usable(): boolean {
    return !this.disposed && !this.ended;
  }

  /** Spawn the server and run the initialize/initialized handshake. */
  async start(): Promise<void> {
    let child: ChildProcess;
    try {
      child = spawn(this.candidate.command, this.candidate.args, {
        cwd: this.workspace,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      throw new ToolError("lsp_unavailable", `Failed to start ${this.candidate.command}: ${errMsg(err)}`);
    }
    this.child = child;
    // Don't let a lingering server keep the Node event loop alive on exit.
    child.unref();
    child.on("error", (err) => {
      this.ended = true;
      this.fail(new ToolError("lsp_unavailable", `${this.candidate.command}: ${err.message}`));
    });
    child.on("exit", () => {
      this.ended = true;
      this.fail(new ToolError("lsp_exited", `${this.candidate.command} exited`));
    });
    child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    // Drain stderr so a chatty server cannot block on a full pipe.
    child.stderr?.on("data", () => {});

    const rootUri = pathToFileURL(this.workspace).toString();
    await this.request(
      "initialize",
      {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.workspace) }],
        capabilities: {
          textDocument: {
            synchronization: { didSave: false, dynamicRegistration: false },
            definition: { dynamicRegistration: false },
            references: { dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: false },
          },
        },
      },
      HANDSHAKE_TIMEOUT_MS,
    );
    this.notify("initialized", {});
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // A wedged/garbage stream (e.g. a header that never terminates) would grow
    // this buffer unbounded. Abort the session rather than risk OOM.
    if (this.buffer.length > MAX_CONTENT_LENGTH * 2) {
      this.buffer = Buffer.alloc(0);
      this.ended = true;
      this.fail(new ToolError("lsp_error", `${this.candidate.command} sent an oversized/garbled stream`));
      void this.dispose();
      return;
    }
    const { messages, rest } = parseLspMessages(this.buffer);
    this.buffer = rest;
    for (const msg of messages) this.dispatch(msg as Record<string, unknown>);
  }

  private dispatch(msg: Record<string, unknown>): void {
    // Response to one of our requests. Our ids are always numbers (nextId++).
    if (typeof msg.id === "number" && ("result" in msg || "error" in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const e = msg.error as { message?: string };
        p.reject(new ToolError("lsp_error", e.message ?? "language server error"));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    // Server → client REQUEST (has both an id AND a method): must be answered or
    // the server stalls. Per JSON-RPC the id may be a string OR a number — echo
    // it back verbatim. `workspace/configuration` expects an array (one entry per
    // requested item), not null, or strict servers error.
    if (msg.id !== undefined && typeof msg.method === "string") {
      let result: unknown = null;
      if (msg.method === "workspace/configuration") {
        const items = (msg.params as { items?: unknown[] } | undefined)?.items;
        result = Array.isArray(items) ? items.map(() => ({})) : [];
      }
      this.send({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }
    // Server → client NOTIFICATION: we only care about diagnostics.
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as { uri?: string; version?: number; diagnostics?: LspDiagnostic[] } | undefined;
      if (params?.uri) {
        const expected = this.diagExpected.get(params.uri);
        // Ignore a publish for an OLDER document version than the one we asked
        // about — it reflects pre-edit state and would answer the wrong question.
        if (expected != null && params.version != null && params.version < expected) return;
        this.diagnostics.set(params.uri, params.diagnostics ?? []);
        const waiter = this.diagWaiters.get(params.uri);
        if (waiter) waiter(); // `done` (below) clears itself and diagExpected
      }
    }
  }

  /** Write a framed message; returns false if the pipe is not writable. */
  private send(message: object): boolean {
    if (!this.child?.stdin?.writable) return false;
    try {
      this.child.stdin.write(encodeLspMessage(message));
      return true;
    } catch {
      // EPIPE / closed pipe between the `writable` check and the write.
      return false;
    }
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.disposed || this.ended) return Promise.reject(new ToolError("lsp_exited", "language server session ended"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ToolError("lsp_timeout", `${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      // If the write can't go out (dead/closed pipe), fail NOW rather than
      // leaving the caller to wait out the full timeout.
      if (!this.send({ jsonrpc: "2.0", id, method, params })) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new ToolError("lsp_exited", "language server is not accepting requests"));
      }
    });
  }

  /** textDocument/didOpen once per file; returns the file's URI. */
  private open(absPath: string): string {
    const uri = pathToFileURL(absPath).toString();
    if (!this.opened.has(uri)) {
      const text = fs.readFileSync(absPath, "utf8");
      this.opened.set(uri, 1);
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: this.languageId, version: 1, text },
      });
    }
    return uri;
  }

  async definition(absPath: string, position: LspPosition): Promise<LspLocation[]> {
    const uri = this.open(absPath);
    const result = await this.request("textDocument/definition", {
      textDocument: { uri },
      position,
    });
    return normalizeLocations(result);
  }

  async references(absPath: string, position: LspPosition): Promise<LspLocation[]> {
    const uri = this.open(absPath);
    const result = await this.request("textDocument/references", {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    });
    return normalizeLocations(result);
  }

  async diagnosticsFor(absPath: string): Promise<LspDiagnostic[]> {
    const uri = pathToFileURL(absPath).toString();
    // Force a fresh diagnostics pass: clear any cached set, (re)open or bump the
    // document version, then wait for the next publishDiagnostics for THIS
    // version (older publishes are ignored in dispatch).
    this.diagnostics.delete(uri);
    let version: number;
    if (this.opened.has(uri)) {
      version = (this.opened.get(uri) ?? 1) + 1;
      this.opened.set(uri, version);
      const text = fs.readFileSync(absPath, "utf8");
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    } else {
      this.open(absPath); // opens at version 1
      version = 1;
    }
    this.diagExpected.set(uri, version);
    return new Promise<LspDiagnostic[]>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.diagWaiters.delete(uri);
        this.diagExpected.delete(uri);
        resolve(this.diagnostics.get(uri) ?? []);
      };
      const timer = setTimeout(done, DIAGNOSTICS_WAIT_MS);
      this.diagWaiters.set(uri, done);
      // A matching-version publish may have landed between the delete above and
      // registering the waiter — settle immediately if so.
      if (this.diagnostics.has(uri)) done();
    });
  }

  private fail(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    for (const [, waiter] of this.diagWaiters) waiter();
    this.diagWaiters.clear();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.fail(new ToolError("lsp_exited", "language server session ended"));
    const c = this.child;
    this.child = null;
    if (c) {
      try {
        c.stdin?.end();
        c.kill();
      } catch {
        // best-effort teardown
      }
    }
  }

  /**
   * Synchronous best-effort kill for the process-`exit` hook, where async
   * teardown (dispose) cannot run to completion. Prevents orphaned servers.
   */
  killSync(): void {
    this.disposed = true;
    const c = this.child;
    this.child = null;
    try {
      c?.kill("SIGKILL");
    } catch {
      // process already gone
    }
  }
}

/** Coerce the several shapes `textDocument/definition|references` can return. */
function normalizeLocations(result: unknown): LspLocation[] {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : [result];
  const out: LspLocation[] = [];
  for (const item of arr) {
    const loc = item as Partial<LspLocation> & Partial<LspLocationLink>;
    if (loc.uri && loc.range) {
      out.push({ uri: loc.uri, range: loc.range });
    } else if (loc.targetUri && loc.targetRange) {
      out.push({ uri: loc.targetUri, range: loc.targetRange });
    }
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Shared session registry (one per languageId) + teardown, mirroring browser.ts.
// ---------------------------------------------------------------------------

const sessions = new Map<string, LspSession>();
let exitHookInstalled = false;

async function getSession(workspace: string, absPath: string): Promise<{ session: LspSession }> {
  const { languageId, candidate } = resolveServerCommand(absPath); // throws when unavailable
  let session = sessions.get(languageId);
  if (session && (session.workspace !== workspace || !session.usable)) {
    // Workspace changed under us, OR the cached server has exited/errored —
    // either way discard the stale session so we don't reuse a dead process
    // (which would hang every request until it times out).
    await session.dispose();
    sessions.delete(languageId);
    session = undefined;
  }
  if (!session) {
    session = new LspSession(workspace, languageId, candidate);
    sessions.set(languageId, session);
    installExitHook();
    try {
      await session.start();
    } catch (err) {
      sessions.delete(languageId);
      await session.dispose();
      throw err;
    }
  }
  return { session };
}

/**
 * Tear down every language-server session and reset state. Idempotent and safe
 * when no server was ever started. Wired into the agent loop's session-end
 * cleanup (mirroring disposeBrowser) with a process-exit fallback below.
 */
export async function disposeLspServers(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map((s) => s.dispose().catch(() => {})));
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const close = (): void => {
    void disposeLspServers();
  };
  process.once("beforeExit", close);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  // `exit` cannot await async work, so kill children SYNCHRONOUSLY here or they
  // leak as orphaned processes on a hard exit.
  process.once("exit", () => {
    for (const s of sessions.values()) s.killSync();
    sessions.clear();
  });
}

// ---------------------------------------------------------------------------
// The operations the tools call. Positions are LSP 0-based here.
// ---------------------------------------------------------------------------

export async function lspDefinition(
  workspace: string,
  absPath: string,
  position: LspPosition,
): Promise<LspLocation[]> {
  const { session } = await getSession(workspace, absPath);
  return session.definition(absPath, position);
}

export async function lspReferences(
  workspace: string,
  absPath: string,
  position: LspPosition,
): Promise<LspLocation[]> {
  const { session } = await getSession(workspace, absPath);
  return session.references(absPath, position);
}

export async function lspDiagnostics(workspace: string, absPath: string): Promise<LspDiagnostic[]> {
  const { session } = await getSession(workspace, absPath);
  return session.diagnosticsFor(absPath);
}

export type { LspLocation };
