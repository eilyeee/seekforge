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
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ToolError } from "../errors.js";
import { abortablePromise, onAbortOnce } from "../../util/abort.js";
import { installProcessTeardown } from "../../util/process-teardown.js";
import { isRecord } from "../../util/guards.js";
import { compareByCodePoints } from "@seekforge/shared";
import { clipLine } from "@seekforge/shared/format";
import { readUtf8FileBoundedSync } from "../../util/fs.js";

const MAX_LSP_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** How much of a server's stderr to keep for explaining an exit. */
const MAX_STDERR_TAIL_CHARS = 4000;
/** How many of its last lines to quote, and how long the quote may get. */
const STDERR_REASON_LINES = 3;
const MAX_STDERR_REASON_CHARS = 400;

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
      const parsed = JSON.parse(body) as unknown;
      if (isRecord(parsed)) messages.push(parsed);
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

type Candidate = {
  command: string;
  args: string[];
  /**
   * Extra arguments that can only be written once the workspace is known.
   *
   * One server needs this: jdtls keeps a per-project workspace of indexes and
   * must be told where. That was the reason Java was left out — the table had
   * nowhere to put a directory. It has one now, under the SeekForge home, which
   * is ours to create rather than a guess about someone's build.
   */
  workspaceArgs?: (workspace: string) => string[];
};
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
  // Everything below serves a language repo_map already outlines. The two
  // surfaces had drifted apart: repo_map covers 19 languages and the lsp_*
  // tools covered four, so a Rust file could be mapped and then not renamed,
  // not have its references found, and not be jumped through — in a repository
  // that is itself part Rust.
  //
  // Each entry names servers that speak LSP over stdio with no extra setup —
  // except Java, whose entry supplies the one thing jdtls needs (see
  // `workspaceArgs`), and C#, which is served by a server that finds the
  // solution itself with OmniSharp behind it.
  ".rs": {
    languageId: "rust",
    servers: [{ command: "rust-analyzer", args: [] }],
    install: "Install the Rust language server: `rustup component add rust-analyzer`.",
  },
  ".c": clangdEntry("c"),
  // `.h` is genuinely ambiguous, and this table answers it differently from
  // the tree-sitter table in repo-map-ast.ts, which maps .h to the C++ grammar
  // because that grammar is a superset and PARSING is all it does. Here the
  // languageId is a claim about the language's RULES, so the conservative
  // answer is C — and clangd resolves the real language from
  // compile_commands.json anyway, which is what actually decides.
  ".h": clangdEntry("c"),
  ".cc": clangdEntry("cpp"),
  ".cpp": clangdEntry("cpp"),
  ".cxx": clangdEntry("cpp"),
  ".hpp": clangdEntry("cpp"),
  ".hh": clangdEntry("cpp"),
  ".hxx": clangdEntry("cpp"),
  ".rb": {
    languageId: "ruby",
    servers: [
      { command: "ruby-lsp", args: [] },
      { command: "solargraph", args: ["stdio"] },
    ],
    install: "Install a Ruby language server: `gem install ruby-lsp` or `gem install solargraph`.",
  },
  ".php": {
    languageId: "php",
    servers: [
      { command: "intelephense", args: STDIO },
      { command: "phpactor", args: ["language-server"] },
    ],
    install: "Install a PHP language server: `npm i -g intelephense` or install phpactor.",
  },
  ".kt": kotlinEntry(),
  ".kts": kotlinEntry(),
  ".swift": {
    languageId: "swift",
    servers: [{ command: "sourcekit-lsp", args: [] }],
    install: "sourcekit-lsp ships with the Swift toolchain — install Swift, or Xcode on macOS.",
  },
  ".scala": scalaEntry(),
  ".sc": scalaEntry(),
  ".lua": {
    languageId: "lua",
    servers: [{ command: "lua-language-server", args: [] }],
    install: "Install the Lua language server: `brew install lua-language-server`, or see LuaLS/lua-language-server.",
  },
  ".zig": {
    languageId: "zig",
    servers: [{ command: "zls", args: [] }],
    install: "Install the Zig language server: `brew install zls`, or see zigtools/zls.",
  },
  ".java": {
    languageId: "java",
    servers: [
      {
        command: "jdtls",
        args: [],
        // jdtls indexes a project into a data directory and will not start
        // without one it can own. Keyed by workspace so two projects never
        // share an index, and rooted in the SeekForge home so nothing is
        // written into the user's repository.
        workspaceArgs: (workspace) => ["-data", jdtlsDataDir(workspace)],
      },
    ],
    // The Java version is in the hint because jdtls enforces it before it does
    // anything else, and a user on the LTS their project targets can easily be
    // below it: measured on a machine with Java 17, jdtls exits immediately
    // with "jdtls requires at least Java 21". It may still COMPILE an older
    // project — the version below is the one that runs the server.
    install:
      "Install the Java language server: `brew install jdtls`, or download eclipse.jdt.ls and put its `jdtls` launcher on PATH. " +
      "jdtls itself needs Java 21+ to run (set JAVA_HOME to a 21+ JDK); the project it analyzes may target an older one.",
  },
  ".cs": {
    languageId: "csharp",
    servers: [
      // csharp-ls discovers the .sln/.csproj itself, which is what makes it
      // usable without asking anyone about their build. OmniSharp stays behind
      // it for the machines that already have it.
      { command: "csharp-ls", args: [] },
      { command: "OmniSharp", args: ["-lsp"] },
      { command: "omnisharp", args: ["-lsp"] },
    ],
    install: "Install a C# language server: `dotnet tool install --global csharp-ls`, or install OmniSharp.",
  },
  ".sh": bashEntry(),
  ".bash": bashEntry(),
  ".zsh": bashEntry(),
};

/**
 * jdtls's per-project data directory: `~/.seekforge/lsp/jdtls/<hash>`.
 *
 * The hash is of the workspace path, so the same project reuses its index
 * across runs and two projects never collide. Not created here —
 * resolveServerCommand stays side-effect-free, and jdtls creates it on start.
 */
export function jdtlsDataDir(workspace: string): string {
  const key = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  return path.join(homedir(), ".seekforge", "lsp", "jdtls", key);
}

/** clangd serves C and C++ from one binary; only the languageId differs. */
function clangdEntry(languageId: string): LangEntry {
  return {
    languageId,
    servers: [{ command: "clangd", args: [] }],
    install:
      "Install clangd: `brew install llvm` (macOS) or your distribution's clangd package. " +
      "It wants a compile_commands.json to resolve includes.",
  };
}

function kotlinEntry(): LangEntry {
  return {
    languageId: "kotlin",
    servers: [{ command: "kotlin-language-server", args: [] }],
    install:
      "Install the Kotlin language server: `brew install kotlin-language-server`, or see fwcd/kotlin-language-server.",
  };
}

function scalaEntry(): LangEntry {
  return {
    languageId: "scala",
    servers: [{ command: "metals", args: [] }],
    install: "Install Metals: `cs install metals` (Coursier), or see scalameta/metals.",
  };
}

function bashEntry(): LangEntry {
  return {
    languageId: "shellscript",
    servers: [{ command: "bash-language-server", args: ["start"] }],
    install: "Install the Bash language server: `npm i -g bash-language-server` (it also wants shellcheck on PATH).",
  };
}

function tsEntry(languageId: string): LangEntry {
  return {
    languageId,
    servers: [{ command: "typescript-language-server", args: STDIO }],
    install: "Install the TypeScript/JavaScript language server: `npm i -g typescript-language-server typescript`.",
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
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
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
export function resolveServerCommand(filePath: string, workspace?: string): Resolved {
  const ext = path.extname(filePath).toLowerCase();
  const entry = EXT_TO_LANG[ext];
  if (!entry) {
    // Derived, not spelled out: this list was written by hand and named three
    // languages while the table held four, and it would have named four while
    // the table held nineteen.
    throw new ToolError(
      "lsp_unsupported",
      `No language server is configured for "${ext || filePath}". Supported: ${Object.keys(EXT_TO_LANG).sort(compareByCodePoints).join(", ")}.`,
    );
  }
  const candidate = entry.servers.find((s) => commandExistsOnPath(s.command));
  if (!candidate) {
    throw new ToolError("lsp_unavailable", entry.install);
  }
  // Workspace-dependent arguments are appended here rather than baked into the
  // table, so the table stays a pure description of what each language needs
  // and a caller with no workspace still gets a runnable base command. (The one
  // caller that has one is getSession; `seekforge doctor` never comes through
  // here at all — it asks lspServerCommands() which binaries exist.)
  if (candidate.workspaceArgs !== undefined && workspace !== undefined) {
    return {
      languageId: entry.languageId,
      candidate: { ...candidate, args: [...candidate.args, ...candidate.workspaceArgs(workspace)] },
    };
  }
  return { languageId: entry.languageId, candidate };
}
/**
 * Every server binary the lsp_* tools might launch, deduped.
 *
 * Exported so `seekforge doctor` can report which are installed without keeping
 * its own copy of the list — a second hand-maintained copy of this table is
 * exactly the drift this repository keeps finding.
 */
export function supportedLspExtensions(): string[] {
  return Object.keys(EXT_TO_LANG).sort(compareByCodePoints);
}

export function lspServerCommands(): string[] {
  const commands = new Set<string>();
  for (const entry of Object.values(EXT_TO_LANG)) {
    for (const server of entry.servers) commands.add(server.command);
  }
  return [...commands].sort(compareByCodePoints);
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

/** One entry from workspace/symbol, normalized across the spec's two shapes. */
export type LspSymbol = {
  name: string;
  kind: string;
  uri: string;
  range: LspRange;
  /** The class/module the symbol belongs to, when the server reports one. */
  container?: string;
};

/** One end of a call edge: the symbol, where it lives, and where the call sites are. */
export type LspCallEdge = {
  name: string;
  kind: string;
  uri: string;
  range: LspRange;
  /** Call sites inside `name` (incoming) or inside the queried symbol (outgoing). */
  callSites: LspRange[];
  detail?: string;
};

/** A super- or subtype of the queried symbol. */
export type LspTypeRelative = {
  name: string;
  kind: string;
  uri: string;
  range: LspRange;
  detail?: string;
};

const SEVERITY: Record<number, string> = { 1: "error", 2: "warning", 3: "information", 4: "hint" };

export function severityLabel(severity?: number): string {
  return severity != null && SEVERITY[severity] ? SEVERITY[severity] : "info";
}

// SymbolKind, from the LSP spec. Reported as a name so the model does not have
// to know the numbering.
const SYMBOL_KINDS: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum-member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type-parameter",
};

export function symbolKindLabel(kind?: number): string {
  return kind != null && SYMBOL_KINDS[kind] ? SYMBOL_KINDS[kind] : "symbol";
}

const ZERO_RANGE: LspRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

/** One entry of a file's outline (textDocument/documentSymbol). */
export type LspOutlineSymbol = {
  name: string;
  kind: string;
  /** 0-based line where the symbol starts. */
  line: number;
  /** Nesting depth: 0 = top level, 1 = a member of the entry above it, … */
  depth: number;
  detail?: string;
};

/** Editor formatting preferences sent with textDocument/formatting. */
export type LspFormattingOptions = { tabSize: number; insertSpaces: boolean };

/** Cap hover text: a doc comment can be very long, and this goes in a tool result. */
const MAX_HOVER_CHARS = 4_000;

/**
 * Flatten a hover result. The spec allows a plain string, a `{language, value}`
 * pair, a markup object, or an array of any of those — all of which mean the
 * same thing to a reader, so they collapse to text.
 */
function normalizeHover(result: unknown): string {
  const render = (part: unknown): string => {
    if (typeof part === "string") return part;
    if (!isRecord(part)) return "";
    if (typeof part.value === "string") return part.value;
    return "";
  };
  if (result === null || result === undefined) return "";
  const contents = isRecord(result) ? result.contents : undefined;
  const parts = Array.isArray(contents) ? contents : [contents];
  const text = parts.map(render).filter(Boolean).join("\n\n").trim();
  return text.length > MAX_HOVER_CHARS ? `${text.slice(0, MAX_HOVER_CHARS)}\n…[truncated]` : text;
}

/** Cap an outline so one generated file cannot flood a tool result. */
const MAX_OUTLINE_SYMBOLS = 500;

/**
 * Flatten a document outline. Servers answer either the newer nested
 * DocumentSymbol tree or the older flat SymbolInformation list; both become one
 * ordered list carrying nesting depth, which is what a reader actually needs.
 */
function normalizeOutline(result: unknown): LspOutlineSymbol[] {
  if (!Array.isArray(result)) return [];
  const out: LspOutlineSymbol[] = [];
  const walk = (items: unknown[], depth: number): void => {
    for (const item of items) {
      if (out.length >= MAX_OUTLINE_SYMBOLS) return;
      if (!isRecord(item) || typeof item.name !== "string") continue;
      const range =
        (isRecord(item.range) ? item.range : undefined) ??
        (isRecord(item.location) && isRecord(item.location.range) ? item.location.range : undefined);
      const start = isRecord(range) && isRecord(range.start) ? range.start : undefined;
      out.push({
        name: item.name,
        kind: symbolKindLabel(typeof item.kind === "number" ? item.kind : undefined),
        line: typeof start?.line === "number" ? start.line : 0,
        depth,
        ...(typeof item.detail === "string" && item.detail ? { detail: item.detail } : {}),
      });
      if (Array.isArray(item.children)) walk(item.children, depth + 1);
    }
  };
  walk(result, 0);
  return out;
}

/**
 * Coerce workspace/symbol results. The older SymbolInformation always carries a
 * full location; the newer WorkspaceSymbol may give only a uri, deferring the
 * range to a resolve request we do not make — those still point at the right
 * file, so they are reported at its start rather than dropped.
 */
function normalizeSymbols(result: unknown): LspSymbol[] {
  if (!Array.isArray(result)) return [];
  const out: LspSymbol[] = [];
  for (const item of result) {
    const symbol = item as {
      name?: unknown;
      kind?: number;
      containerName?: unknown;
      location?: { uri?: unknown; range?: LspRange };
    };
    if (typeof symbol?.name !== "string" || typeof symbol.location?.uri !== "string") continue;
    out.push({
      name: symbol.name,
      kind: symbolKindLabel(symbol.kind),
      uri: symbol.location.uri,
      range: symbol.location.range ?? ZERO_RANGE,
      ...(typeof symbol.containerName === "string" && symbol.containerName ? { container: symbol.containerName } : {}),
    });
  }
  return out;
}

/**
 * A hierarchy item is the same shape in both the call and type protocols, and
 * both answer with `{ from | to | item, fromRanges? }` wrappers. Reading the
 * item out of either wrapper keeps one normalizer for four requests.
 */
function hierarchyItem(
  value: unknown,
): { name: string; kind: string; uri: string; range: LspRange; detail?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const name = value["name"];
  const uri = value["uri"];
  if (typeof name !== "string" || typeof uri !== "string") return undefined;
  const range = isRecord(value["selectionRange"]) ? value["selectionRange"] : value["range"];
  return {
    name,
    kind: symbolKindLabel(typeof value["kind"] === "number" ? value["kind"] : undefined),
    uri,
    range: (range as LspRange | undefined) ?? ZERO_RANGE,
    ...(typeof value["detail"] === "string" && value["detail"] ? { detail: value["detail"] } : {}),
  };
}

function normalizeCallEdges(result: unknown, side: "from" | "to"): LspCallEdge[] {
  if (!Array.isArray(result)) return [];
  const out: LspCallEdge[] = [];
  for (const entry of result) {
    if (!isRecord(entry)) continue;
    const item = hierarchyItem(entry[side]);
    if (!item) continue;
    const ranges = entry["fromRanges"];
    out.push({
      ...item,
      callSites: Array.isArray(ranges) ? (ranges.filter(isRecord) as LspRange[]) : [],
    });
  }
  return out;
}

function normalizeTypeRelatives(result: unknown): LspTypeRelative[] {
  if (!Array.isArray(result)) return [];
  return result.map(hierarchyItem).filter((item): item is LspTypeRelative => item !== undefined);
}

// ---------------------------------------------------------------------------
// Session: one long-lived server process per languageId + workspace.
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 15_000;
/**
 * Budget for the FIRST answer a freshly started server gives.
 *
 * A server accepts `initialize` long before it can answer a question about the
 * code: it still has to read the project and build an index, and on a cold
 * workspace that is the slowest thing it will ever do. Measured with jdtls on
 * an empty `-data` directory, the first `textDocument/documentSymbol` did not
 * return inside 15s — which made Java look broken on first use and fine
 * afterwards, the worst shape a timeout can have. Only the first request pays
 * this; once one has come back, the ordinary budget applies.
 */
const FIRST_REQUEST_TIMEOUT_MS = 120_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;
const DIAGNOSTICS_WAIT_MS = 4_000;
// After SIGTERM on dispose, escalate to SIGKILL if the server has not exited
// within this window, so a server that ignores SIGTERM cannot leave an orphan.
const DISPOSE_GRACE_MS = 5_000;

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  /** Detaches the abort listener; installed right after the entry is registered. */
  offAbort?: () => void;
};
type DiagnosticWaiter = {
  resolve: (diagnostics: LspDiagnostic[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};
type DiagnosticRun = { promise: Promise<LspDiagnostic[]>; subscribers: number };

class LspSession {
  readonly workspace: string;
  private readonly languageId: string;
  private readonly candidate: Candidate;
  private child: ChildProcess | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly opened = new Map<string, { version: number; text: string }>();
  private readonly diagnostics = new Map<string, LspDiagnostic[]>();
  private readonly diagWaiters = new Map<string, DiagnosticWaiter>();
  private readonly diagnosticRuns = new Map<string, DiagnosticRun>();
  // uri → the document version we last asked diagnostics for, so a stale
  // publishDiagnostics for an older version can be ignored.
  private readonly diagExpected = new Map<string, number>();
  private disposed = false;
  // Set once the child process errors or exits. A session in this state can
  // never serve another request, so the registry must discard it (not reuse
  // the cached-but-dead process, which would hang every call until timeout).
  private ended = false;
  /**
   * The tail of what the server wrote to stderr.
   *
   * This used to be drained into nothing, so a server that refused to start
   * reported `jdtls exited` and kept its reason to itself — while having
   * printed the exact, actionable one ("jdtls requires at least Java 21").
   * Bounded because the original reason for draining stands: a chatty server
   * must not be able to fill the pipe or this buffer.
   */
  private stderrTail = "";
  /** Whether `initialize` has been answered — see the note where it is set. */
  private handshakeDone = false;
  /** Whether a post-handshake request has been answered. See FIRST_REQUEST_TIMEOUT_MS. */
  private answered = false;

  constructor(workspace: string, languageId: string, candidate: Candidate) {
    this.workspace = workspace;
    this.languageId = languageId;
    this.candidate = candidate;
  }

  /**
   * The last few lines the server printed, as a clause to append to an error.
   *
   * Last lines rather than first: a JVM stack trace ends with the message that
   * explains it, and a server that logged progress before failing put the
   * reason at the bottom.
   */
  private stderrReason(): string {
    const lines = this.stderrTail
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const tail = lines.slice(-STDERR_REASON_LINES).join("; ");
    return tail ? `: ${clipLine(tail, MAX_STDERR_REASON_CHARS)}` : "";
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
      this.fail(new ToolError("lsp_exited", `${this.candidate.command} exited${this.stderrReason()}`));
    });
    child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    // Drained so a chatty server cannot block on a full pipe, but kept: what it
    // wrote here is usually the only explanation of why it is about to exit.
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-MAX_STDERR_TAIL_CHARS);
    });

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
            rename: { dynamicRegistration: false, prepareSupport: false },
            hover: { dynamicRegistration: false, contentFormat: ["plaintext", "markdown"] },
            documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
            codeAction: {
              dynamicRegistration: false,
              // Servers answer the newer CodeAction shape only when the client
              // says it understands it; otherwise they fall back to Command,
              // which carries no edit we could review.
              codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix", "refactor", "source"] } },
              resolveSupport: { properties: ["edit"] },
            },
            formatting: { dynamicRegistration: false },
            // Both hierarchies are two-step protocols: prepare returns an item,
            // and the item is what the follow-up request takes.
            callHierarchy: { dynamicRegistration: false },
            typeHierarchy: { dynamicRegistration: false },
          },
          workspace: {
            // documentChanges gets the versioned edit shape; the empty
            // resourceOperations list tells the server we cannot create, rename
            // or delete files, so it should not answer with any.
            workspaceEdit: { documentChanges: true, resourceOperations: [], failureHandling: "abort" },
            symbol: { dynamicRegistration: false },
          },
        },
      },
      HANDSHAKE_TIMEOUT_MS,
    );
    this.notify("initialized", {});
    // From here the server is talking to us but may not yet know the project:
    // the next request is the one that waits for its index. `initialize` came
    // back long before that, which is why it does not count as the first
    // answer.
    this.handshakeDone = true;
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
      const p = this.takePending(msg.id);
      if (!p) return;
      // Answered at all — including with an error — means indexing is behind
      // us and later requests get the ordinary budget. Responses to the
      // handshake itself arrive before any of that and do not count.
      if (this.handshakeDone) this.answered = true;
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
        if (this.diagWaiters.has(params.uri)) this.finishDiagnostics(params.uri);
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

  private request(
    method: string,
    params: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.disposed || this.ended)
      return Promise.reject(new ToolError("lsp_exited", "language server session ended"));
    if (signal?.aborted) return Promise.reject(cancelledError());
    // The first answer includes however long this server needs to index the
    // project; every one after it does not. A caller that asked for a longer
    // budget keeps it — this only raises a floor, never lowers a ceiling.
    if (!this.answered) timeoutMs = Math.max(timeoutMs, FIRST_REQUEST_TIMEOUT_MS);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.takePending(id)) return;
        this.notify("$/cancelRequest", { id });
        reject(new ToolError("lsp_timeout", `${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const pending: Pending = { resolve, reject, timer };
      this.pending.set(id, pending);
      pending.offAbort = onAbortOnce(signal, () => {
        if (!this.takePending(id)) return;
        this.notify("$/cancelRequest", { id });
        reject(cancelledError());
      });
      // An already-aborted signal fired synchronously above: rejected, entry
      // taken — do not send the request at all.
      if (signal?.aborted) return;
      // If the write can't go out (dead/closed pipe), fail NOW rather than
      // leaving the caller to wait out the full timeout.
      if (!this.send({ jsonrpc: "2.0", id, method, params })) {
        this.takePending(id);
        reject(new ToolError("lsp_exited", "language server is not accepting requests"));
      }
    });
  }

  private takePending(id: number): Pending | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.offAbort?.();
    return pending;
  }

  /** Keep the server's document snapshot aligned with the file on disk. */
  private syncDocument(absPath: string, forceChange = false): { uri: string; version: number } {
    const uri = pathToFileURL(absPath).toString();
    const text = readUtf8FileBoundedSync(absPath, MAX_LSP_DOCUMENT_BYTES);
    const current = this.opened.get(uri);
    if (!current) {
      this.opened.set(uri, { version: 1, text });
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: this.languageId, version: 1, text },
      });
      return { uri, version: 1 };
    }
    if (forceChange || current.text !== text) {
      const version = current.version + 1;
      this.opened.set(uri, { version, text });
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
      return { uri, version };
    }
    return { uri, version: current.version };
  }

  async definition(absPath: string, position: LspPosition, signal?: AbortSignal): Promise<LspLocation[]> {
    const { uri } = this.syncDocument(absPath);
    const result = await this.request(
      "textDocument/definition",
      {
        textDocument: { uri },
        position,
      },
      REQUEST_TIMEOUT_MS,
      signal,
    );
    return normalizeLocations(result);
  }

  async references(absPath: string, position: LspPosition, signal?: AbortSignal): Promise<LspLocation[]> {
    const { uri } = this.syncDocument(absPath);
    const result = await this.request(
      "textDocument/references",
      {
        textDocument: { uri },
        position,
        context: { includeDeclaration: true },
      },
      REQUEST_TIMEOUT_MS,
      signal,
    );
    return normalizeLocations(result);
  }

  async rename(absPath: string, position: LspPosition, newName: string, signal?: AbortSignal): Promise<unknown> {
    const { uri } = this.syncDocument(absPath);
    return this.request(
      "textDocument/rename",
      {
        textDocument: { uri },
        position,
        newName,
      },
      REQUEST_TIMEOUT_MS,
      signal,
    );
  }

  async hover(absPath: string, position: LspPosition, signal?: AbortSignal): Promise<string> {
    const { uri } = this.syncDocument(absPath);
    const result = await this.request(
      "textDocument/hover",
      { textDocument: { uri }, position },
      REQUEST_TIMEOUT_MS,
      signal,
    );
    return normalizeHover(result);
  }

  async documentSymbols(absPath: string, signal?: AbortSignal): Promise<LspOutlineSymbol[]> {
    const { uri } = this.syncDocument(absPath);
    const result = await this.request(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
      REQUEST_TIMEOUT_MS,
      signal,
    );
    return normalizeOutline(result);
  }

  async codeActions(
    absPath: string,
    range: LspRange,
    diagnostics: LspDiagnostic[],
    only: string | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const { uri } = this.syncDocument(absPath);
    return this.request(
      "textDocument/codeAction",
      {
        textDocument: { uri },
        range,
        context: { diagnostics, ...(only ? { only: [only] } : {}) },
      },
      REQUEST_TIMEOUT_MS,
      signal,
    );
  }

  /** Resolve a code action that arrived without its edit (spec: codeAction/resolve). */
  async resolveCodeAction(action: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request("codeAction/resolve", action, REQUEST_TIMEOUT_MS, signal);
  }

  async formatting(absPath: string, options: LspFormattingOptions, signal?: AbortSignal): Promise<unknown> {
    const { uri } = this.syncDocument(absPath);
    return this.request("textDocument/formatting", { textDocument: { uri }, options }, REQUEST_TIMEOUT_MS, signal);
  }

  /**
   * Who calls this, and what does it call.
   *
   * Two round trips by protocol: prepare resolves the position to a hierarchy
   * item, and only that item may be passed on. A position that resolves to no
   * item (whitespace, a keyword) is not an error — there is simply nothing at
   * the cursor to ask about.
   */
  async callHierarchy(
    absPath: string,
    position: LspPosition,
    direction: "incoming" | "outgoing",
    signal?: AbortSignal,
  ): Promise<LspCallEdge[]> {
    const { uri } = this.syncDocument(absPath);
    const prepared = await this.request(
      "textDocument/prepareCallHierarchy",
      { textDocument: { uri }, position },
      REQUEST_TIMEOUT_MS,
      signal,
    );
    const item = Array.isArray(prepared) ? prepared[0] : undefined;
    if (!isRecord(item)) return [];
    const method = direction === "incoming" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls";
    const result = await this.request(method, { item }, REQUEST_TIMEOUT_MS, signal);
    return normalizeCallEdges(result, direction === "incoming" ? "from" : "to");
  }

  /** What this type extends, or what extends it. Same two-step shape as the call hierarchy. */
  async typeHierarchy(
    absPath: string,
    position: LspPosition,
    direction: "supertypes" | "subtypes",
    signal?: AbortSignal,
  ): Promise<LspTypeRelative[]> {
    const { uri } = this.syncDocument(absPath);
    const prepared = await this.request(
      "textDocument/prepareTypeHierarchy",
      { textDocument: { uri }, position },
      REQUEST_TIMEOUT_MS,
      signal,
    );
    const item = Array.isArray(prepared) ? prepared[0] : undefined;
    if (!isRecord(item)) return [];
    const method = direction === "supertypes" ? "typeHierarchy/supertypes" : "typeHierarchy/subtypes";
    return normalizeTypeRelatives(await this.request(method, { item }, REQUEST_TIMEOUT_MS, signal));
  }

  async workspaceSymbols(query: string, signal?: AbortSignal): Promise<LspSymbol[]> {
    const result = await this.request("workspace/symbol", { query }, REQUEST_TIMEOUT_MS, signal);
    return normalizeSymbols(result);
  }

  async diagnosticsFor(absPath: string, signal?: AbortSignal): Promise<LspDiagnostic[]> {
    if (signal?.aborted) throw cancelledError();
    const uri = pathToFileURL(absPath).toString();
    let run = this.diagnosticRuns.get(uri);
    if (!run) {
      run = { promise: this.collectDiagnostics(absPath, uri), subscribers: 0 };
      this.diagnosticRuns.set(uri, run);
      const cleanup = (): void => {
        if (this.diagnosticRuns.get(uri) === run) this.diagnosticRuns.delete(uri);
      };
      void run.promise.then(cleanup, cleanup);
    }
    run.subscribers++;
    try {
      return await abortable(run.promise, signal);
    } finally {
      run.subscribers--;
      if (run.subscribers === 0 && this.diagnosticRuns.get(uri) === run && this.diagWaiters.has(uri)) {
        this.finishDiagnostics(uri, cancelledError());
      }
    }
  }

  private finishDiagnostics(uri: string, err?: Error): void {
    const waiter = this.diagWaiters.get(uri);
    if (!waiter) return;
    this.diagWaiters.delete(uri);
    this.diagExpected.delete(uri);
    clearTimeout(waiter.timer);
    if (err) waiter.reject(err);
    else waiter.resolve(this.diagnostics.get(uri) ?? []);
  }

  private collectDiagnostics(absPath: string, uri: string): Promise<LspDiagnostic[]> {
    if (this.disposed || this.ended) {
      return Promise.reject(new ToolError("lsp_exited", "language server session ended"));
    }
    // Force a fresh diagnostics pass: clear any cached set, (re)open or bump the
    // document version, then wait for the next publishDiagnostics for THIS
    // version (older publishes are ignored in dispatch).
    this.diagnostics.delete(uri);
    const { version } = this.syncDocument(absPath, this.opened.has(uri));
    this.diagExpected.set(uri, version);
    return new Promise<LspDiagnostic[]>((resolve, reject) => {
      const timer = setTimeout(() => this.finishDiagnostics(uri), DIAGNOSTICS_WAIT_MS);
      this.diagWaiters.set(uri, { resolve, reject, timer });
      // A matching-version publish may have landed between the delete above and
      // registering the waiter — settle immediately if so.
      if (this.diagnostics.has(uri)) this.finishDiagnostics(uri);
    });
  }

  private fail(err: Error): void {
    for (const id of [...this.pending.keys()]) {
      const pending = this.takePending(id);
      pending?.reject(err);
    }
    for (const uri of [...this.diagWaiters.keys()]) {
      this.finishDiagnostics(uri, err);
    }
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
        // A server that ignores SIGTERM would otherwise linger as an orphan;
        // force-kill after a grace window. Unref'd so it never holds the loop
        // open, and cleared as soon as the process exits.
        const forceKill = setTimeout(() => {
          try {
            c.kill("SIGKILL");
          } catch {
            // already gone
          }
        }, DISPOSE_GRACE_MS);
        forceKill.unref();
        c.once("exit", () => clearTimeout(forceKill));
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

function workspaceIdentity(workspace: string): string {
  const resolved = path.resolve(workspace);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function cancelledError(): ToolError {
  return new ToolError("cancelled", "LSP request cancelled");
}

const abortable = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> =>
  abortablePromise(promise, signal, cancelledError);

// ---------------------------------------------------------------------------
// Shared session registry (one per workspace + languageId) + teardown.
// ---------------------------------------------------------------------------

const sessions = new Map<string, LspSession>();
const startingSessions = new Map<string, Promise<LspSession>>();
const workspaceLeases = new Map<string, Set<symbol>>();
let exitHookInstalled = false;

async function getSession(workspace: string, absPath: string, signal?: AbortSignal): Promise<{ session: LspSession }> {
  if (signal?.aborted) throw cancelledError();
  workspace = workspaceIdentity(workspace);
  const { languageId, candidate } = resolveServerCommand(absPath, workspace); // throws when unavailable
  const key = `${workspace}\0${languageId}`;
  const starting = startingSessions.get(key);
  if (starting) {
    const session = await abortable(starting, signal);
    if (session.usable) return { session };
  }
  let session = sessions.get(key);
  if (session && !session.usable) {
    // Discard a cached server that exited/errored so future requests do not
    // reuse a dead process and wait for the request timeout.
    await session.dispose();
    sessions.delete(key);
    session = undefined;
  }
  if (!session) {
    session = new LspSession(workspace, languageId, candidate);
    sessions.set(key, session);
    installExitHook();
    const created = session;
    const startup = created
      .start()
      .then(() => created)
      .catch(async (err: unknown) => {
        if (sessions.get(key) === created) sessions.delete(key);
        await created.dispose();
        throw err;
      })
      .finally(() => {
        if (startingSessions.get(key) === startup) startingSessions.delete(key);
      });
    startingSessions.set(key, startup);
    await abortable(startup, signal);
  }
  return { session };
}

/**
 * Force-dispose every language-server session and invalidate all leases.
 * Normal agent-run cleanup releases its LspServerLease instead.
 */
export async function disposeLspServers(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  startingSessions.clear();
  workspaceLeases.clear();
  await Promise.all(all.map((s) => s.dispose().catch(() => {})));
}

export type LspServerLease = {
  /** Release this run's ownership. The final release disposes only this workspace. */
  release(): Promise<void>;
};

/**
 * Retain shared LSP sessions for one agent run. Runs in the same workspace may
 * share servers; a run's release cannot tear them down while another lease is
 * still active.
 */
export function acquireLspServerLease(workspace: string): LspServerLease {
  const workspaceKey = workspaceIdentity(workspace);
  const token = Symbol("lsp-server-lease");
  let leases = workspaceLeases.get(workspaceKey);
  if (!leases) {
    leases = new Set();
    workspaceLeases.set(workspaceKey, leases);
  }
  leases.add(token);
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      const current = workspaceLeases.get(workspaceKey);
      if (!current?.delete(token) || current.size > 0) return;
      workspaceLeases.delete(workspaceKey);
      await disposeWorkspaceLspServers(workspaceKey);
    },
  };
}

async function disposeWorkspaceLspServers(workspace: string): Promise<void> {
  const disposing: LspSession[] = [];
  for (const [key, session] of sessions) {
    if (session.workspace !== workspace) continue;
    sessions.delete(key);
    startingSessions.delete(key);
    disposing.push(session);
  }
  await Promise.all(disposing.map((session) => session.dispose().catch(() => {})));
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  installProcessTeardown({
    onSignal: () => void disposeLspServers(),
    // `exit` cannot await async work, so kill children SYNCHRONOUSLY here or
    // they leak as orphaned processes on a hard exit.
    onExit: () => {
      for (const s of sessions.values()) s.killSync();
      sessions.clear();
    },
  });
}

// ---------------------------------------------------------------------------
// The operations the tools call. Positions are LSP 0-based here.
// ---------------------------------------------------------------------------

export async function lspDefinition(
  workspace: string,
  absPath: string,
  position: LspPosition,
  signal?: AbortSignal,
): Promise<LspLocation[]> {
  const { session } = await getSession(workspace, absPath, signal);
  return session.definition(absPath, position, signal);
}

export async function lspCallHierarchy(
  workspace: string,
  absPath: string,
  position: LspPosition,
  direction: "incoming" | "outgoing",
  signal?: AbortSignal,
): Promise<LspCallEdge[]> {
  const { session } = await getSession(workspace, absPath, signal);
  return session.callHierarchy(absPath, position, direction, signal);
}

export async function lspTypeHierarchy(
  workspace: string,
  absPath: string,
  position: LspPosition,
  direction: "supertypes" | "subtypes",
  signal?: AbortSignal,
): Promise<LspTypeRelative[]> {
  const { session } = await getSession(workspace, absPath, signal);
  return session.typeHierarchy(absPath, position, direction, signal);
}

export async function lspReferences(
  workspace: string,
  absPath: string,
  position: LspPosition,
  signal?: AbortSignal,
): Promise<LspLocation[]> {
  const { session } = await getSession(workspace, absPath, signal);
  return session.references(absPath, position, signal);
}

export async function lspDiagnostics(
  workspace: string,
  absPath: string,
  signal?: AbortSignal,
): Promise<LspDiagnostic[]> {
  const { session } = await getSession(workspace, absPath, signal);
  return session.diagnosticsFor(absPath, signal);
}

/** The compiler's own description of the symbol at `position` (type, signature, doc). */
export async function lspHover(
  workspace: string,
  absPath: string,
  position: LspPosition,
  signal?: AbortSignal,
): Promise<string> {
  const { session } = await getSession(workspace, absPath, signal);
  return session.hover(absPath, position, signal);
}

/** A precise outline of one file, straight from the parser. */
export async function lspDocumentSymbols(
  workspace: string,
  absPath: string,
  signal?: AbortSignal,
): Promise<LspOutlineSymbol[]> {
  const { session } = await getSession(workspace, absPath, signal);
  return session.documentSymbols(absPath, signal);
}

/**
 * The fixes the language server offers for a range — usually for the
 * diagnostics reported there, which are fetched first so the server has the
 * context it needs to answer.
 */
export async function lspCodeActions(
  workspace: string,
  absPath: string,
  range: LspRange,
  only: string | undefined,
  signal?: AbortSignal,
): Promise<unknown> {
  const { session } = await getSession(workspace, absPath, signal);
  const diagnostics = (await session.diagnosticsFor(absPath, signal)).filter((d) => rangesOverlap(d.range, range));
  return session.codeActions(absPath, range, diagnostics, only, signal);
}

/** Resolve a code action the server returned without its edit. */
export async function lspResolveCodeAction(
  workspace: string,
  absPath: string,
  action: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const { session } = await getSession(workspace, absPath, signal);
  return session.resolveCodeAction(action, signal);
}

/** Whole-file formatting edits. */
export async function lspFormatting(
  workspace: string,
  absPath: string,
  options: LspFormattingOptions,
  signal?: AbortSignal,
): Promise<unknown> {
  const { session } = await getSession(workspace, absPath, signal);
  return session.formatting(absPath, options, signal);
}

/** True when two ranges share at least one position. */
function rangesOverlap(a: LspRange, b: LspRange): boolean {
  const before = (p: LspPosition, q: LspPosition): boolean =>
    p.line < q.line || (p.line === q.line && p.character <= q.character);
  return before(a.start, b.end) && before(b.start, a.end);
}

/** Ask the language server for the edit that renames the symbol at `position`. */
export async function lspRename(
  workspace: string,
  absPath: string,
  position: LspPosition,
  newName: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const { session } = await getSession(workspace, absPath, signal);
  return session.rename(absPath, position, newName, signal);
}

/**
 * Search symbols across the project.
 *
 * `hintPath` names a file in the language to search — workspace/symbol is a
 * server-wide request, and which server answers it depends on the language.
 * Without a hint, every server already running for this workspace is asked,
 * which is the one the agent has been using; if none is, that is reported
 * rather than guessed at.
 */
export async function lspWorkspaceSymbols(
  workspace: string,
  query: string,
  hintPath?: string,
  signal?: AbortSignal,
): Promise<LspSymbol[]> {
  if (hintPath !== undefined) {
    const { session } = await getSession(workspace, hintPath, signal);
    return session.workspaceSymbols(query, signal);
  }
  const key = workspaceIdentity(workspace);
  const running = [...sessions.values()].filter((session) => session.workspace === key && session.usable);
  if (running.length === 0) {
    throw new ToolError(
      "lsp_no_session",
      "no language server is running for this workspace — pass `path` naming any file in the language to search",
    );
  }
  const seen = new Set<string>();
  const merged: LspSymbol[] = [];
  for (const session of running) {
    for (const symbol of await session.workspaceSymbols(query, signal)) {
      const id = `${symbol.uri}\0${symbol.range.start.line}\0${symbol.range.start.character}\0${symbol.name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(symbol);
    }
  }
  return merged;
}

export type { LspLocation, LspRange };
