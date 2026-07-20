import { spawn } from "node:child_process";
import { basename, normalize } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isSensitiveBasename, isSensitiveRelPath } from "@seekforge/shared";
import { ToolError } from "./errors.js";
import { onAbortOnce } from "../util/abort.js";
import { scrubSecretEnv } from "../util/scrub-env.js";
import { buildSandboxSpec, sandboxedShell, type SandboxLevel } from "./os-sandbox.js";

export type CommandPermission = "readonly" | "execute" | "env" | "dangerous";

export type CommandClassification = {
  permission: CommandPermission;
  /** True when an "execute" command matched the allowlist (may auto-run). */
  allowlisted: boolean;
  /** Default timeout for this command class. */
  defaultTimeoutMs: number;
  /** Which rule classified the command (for prompts/logs). */
  reason: string;
};

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/**
 * Detect shell control syntax that can execute more than the apparent command
 * or redirect its I/O. Quoted/escaped operators are ordinary arguments, except
 * command substitution remains active inside double quotes.
 */
export function hasShellControlSyntax(command: string): boolean {
  let quote: "single" | "double" | undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote === "single") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === "'") {
      if (quote === undefined) quote = "single";
      continue;
    }
    if (char === '"') {
      quote = quote === "double" ? undefined : "double";
      continue;
    }
    if (char === "`" || (char === "$" && command[i + 1] === "(")) return true;
    if (quote === undefined && ";&|<>\n\r".includes(char)) return true;
  }
  return false;
}

/**
 * True if the shell command `ran` is an invocation of the configured command
 * `configured` — i.e. it equals it, or extends it with extra args at a word
 * boundary (`pnpm test` matches `pnpm test --watch` but NOT `pnpm test:watch`).
 * Both sides are whitespace-normalized. Used to decide whether the model's own
 * run satisfied the verify/lint gate — a bare `.includes()` gives false
 * positives (`echo "pnpm test"`) and false negatives (extra whitespace).
 */
export function commandInvokes(ran: string, configured: string): boolean {
  if (hasShellControlSyntax(ran)) return false;
  const a = normalizeCommand(ran);
  const b = normalizeCommand(configured);
  if (!b) return false;
  return a === b || a.startsWith(b + " ");
}

type ShellParseResult = { invocations: string[][]; next: number };

/** Parse shell words without evaluating expansion, retaining nested command
 * substitutions as independent invocations for security classification. */
function parseShellSegment(source: string, start = 0, terminator?: ")" | "`"): ShellParseResult {
  const invocations: string[][] = [];
  let words: string[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "'" | '"' | undefined;

  const finishWord = () => {
    if (wordStarted) words.push(word);
    word = "";
    wordStarted = false;
  };
  const finishInvocation = () => {
    finishWord();
    if (words.length > 0) invocations.push(words);
    words = [];
  };

  for (let i = start; i < source.length; i++) {
    const ch = source.charAt(i);
    const next = source.charAt(i + 1);
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else word += ch;
      continue;
    }
    if (ch === "\\") {
      wordStarted = true;
      if (i + 1 < source.length) word += source.charAt(++i);
      else word += "\\";
      continue;
    }
    if (quote === '"' && ch === '"') {
      quote = undefined;
      continue;
    }
    if (ch === "$" && next === "(") {
      wordStarted = true;
      const nested = parseShellSegment(source, i + 2, ")");
      invocations.push(...nested.invocations);
      i = nested.next;
      continue;
    }
    if (ch === "`") {
      if (terminator === "`") {
        finishInvocation();
        return { invocations, next: i };
      }
      wordStarted = true;
      const nested = parseShellSegment(source, i + 1, "`");
      invocations.push(...nested.invocations);
      i = nested.next;
      continue;
    }
    if (quote === '"') {
      word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      wordStarted = true;
      continue;
    }
    if (terminator === ")" && ch === ")") {
      finishInvocation();
      return { invocations, next: i };
    }
    if (ch === "(") {
      finishInvocation();
      const nested = parseShellSegment(source, i + 1, ")");
      invocations.push(...nested.invocations);
      i = nested.next;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n" || ch === "\r") {
      finishInvocation();
      continue;
    }
    if (/\s/.test(ch)) {
      finishWord();
      continue;
    }
    wordStarted = true;
    word += ch;
  }
  finishInvocation();
  return { invocations, next: source.length };
}

function gitArgumentRuns(command: string): string[][] {
  return parseShellSegment(command).invocations.flatMap((invocation) =>
    invocation.flatMap((word, index) => (word.split(/[\\/]/).at(-1) === "git" ? [invocation.slice(index + 1)] : [])),
  );
}

function gitSubcommandIndex(args: readonly string[]): number {
  const optionsWithValue = new Set([
    "-c",
    "-C",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--super-prefix",
    "--config-env",
  ]);
  let index = 0;
  while (index < args.length) {
    const argument = args[index] ?? "";
    if (optionsWithValue.has(argument)) index = Math.min(index + 2, args.length);
    else if (argument.startsWith("-")) index++;
    else break;
  }
  return index;
}

function classifyGitPolicy(command: string): { dangerous?: string; pushes: boolean } {
  let pushes = false;
  for (const args of gitArgumentRuns(command)) {
    const index = gitSubcommandIndex(args);
    const subcommand = args[index];
    if (subcommand === "reset" && args.slice(index + 1).includes("--hard")) {
      return { dangerous: "git reset --hard", pushes };
    }
    if (subcommand === "clean") return { dangerous: "git clean", pushes };
    if (subcommand === "push") {
      pushes = true;
      if (args.slice(index + 1).some((argument) => argument === "-f" || argument.startsWith("--force"))) {
        return { dangerous: "git push --force", pushes };
      }
    }
  }
  return { pushes };
}

/**
 * ripgrep flags that turn a search into code execution (`--pre`, `--search-zip`,
 * `--hostname-bin`) or an unrestricted read of ignored/hidden files such as
 * `.env` (`--hidden`, `--no-ignore*`, `-u`/`-uu`/`-uuu`). Their presence forces
 * `rg` off the auto-run path and onto the confirmation flow — a plain
 * `rg <pattern> <path>` still auto-runs.
 */
const RG_UNSAFE_FLAGS =
  /(?:^|\s)(?:--pre(?:=|\b)|--pre-glob\b|--search-zip\b|--hostname-bin\b|--hidden\b|--no-ignore(?:-[a-z]+)?\b|--unrestricted\b|-z\b|-[A-Za-z]*u[A-Za-z]*\b)/;

function referencesSensitivePath(tokens: readonly string[]): boolean {
  return tokens.some((raw) => {
    const unquoted = raw.replace(/^['"]|['"]$/g, "");
    const value = unquoted.includes("=") ? (unquoted.split("=", 2)[1] ?? unquoted) : unquoted;
    const path = normalize(value).replace(/\\/g, "/");
    if (isSensitiveBasename(basename(path))) return true;
    const segments = path.split("/").filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
      if (isSensitiveRelPath(segments.slice(i).join("/"))) return true;
    }
    return false;
  });
}

function referencesUnboundedPath(tokens: readonly string[]): boolean {
  return tokens.some((raw) => {
    const value = raw.replace(/^['"]|['"]$/g, "");
    if (value.startsWith("/") || value.startsWith("~") || value.startsWith("$") || /^[A-Za-z]:[\\/]/.test(value)) {
      return true;
    }
    const path = normalize(value.replace(/\\/g, "/")).replace(/\\/g, "/");
    return path === ".." || path.startsWith("../");
  });
}

/** Destructive / escape-hatch commands. Never run, never prompt. */
const DENYLIST: Array<{ re: RegExp; reason: string }> = [
  // rm with BOTH a recursive flag (-r/-R/-rf/--recursive, any case/order) AND a
  // force flag (-f/--force). Order-independent so "rm -R -f", "rm -Rf",
  // "rm --recursive --force", "rm -fr" etc. are all caught (commands are
  // whitespace-normalized to a single line before matching).
  {
    re: /\brm\b(?=.*(?:\s-[a-zA-Z]*[rR][a-zA-Z]*\b|\s--recursive\b))(?=.*(?:\s-[a-zA-Z]*[fF][a-zA-Z]*\b|\s--force\b))/,
    reason: "rm recursive+force",
  },
  { re: /\bsudo\b/, reason: "sudo" },
  { re: /\bchmod\s+(-[^\s]+\s+)*-R\b/, reason: "chmod -R" },
  { re: /\bchown\b/, reason: "chown" },
  {
    re: /\b(curl|wget)\b[^|;&]*\|\s*([^\s|;&]+\s+)*(sh|bash|zsh|dash|ksh|fish|ash)\b/,
    reason: "download piped to shell",
  },
  // Any POSIX/alt shell invoked with -c runs an arbitrary nested command.
  { re: /\b(bash|sh|zsh|dash|ksh|fish|ash|csh|tcsh)\s+-c\b/, reason: "nested shell -c" },
  { re: /\bnode\s+(-[^\s]+\s+)*(-e|--eval)\b/, reason: "node -e" },
  // Match versioned interpreters too (python3.11, python3.12, …).
  { re: /\bpython[\d.]*\s+(-[^\s]+\s+)*-c\b/, reason: "python -c" },
  { re: /\b(perl|ruby)\s+(-[^\s]+\s+)*-e\b/, reason: "perl/ruby -e" },
  { re: /\bdeno\s+eval\b/, reason: "deno eval" },
  { re: /\bbun\s+(-[^\s]+\s+)*(-e|--eval)\b/, reason: "bun -e" },
];

/** Dependency / environment changes: always require confirmation (L3). */
const ENV_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(npm|pnpm|yarn)\s+(install|add|i)\b/, reason: "package install" },
  { re: /\bpip3?\s+install\b/, reason: "pip install" },
  { re: /\bcargo\s+add\b/, reason: "cargo add" },
];

/** Commands safe to auto-run without confirmation (prefix match, normalized). */
export const BUILTIN_COMMAND_ALLOWLIST: readonly string[] = [
  "pwd",
  "ls",
  "rg",
  // Read-only git (status / diff / log / …) is auto-allowed via the classifyGit
  // fast-path, which — unlike a bare prefix match — rejects output-writing forms
  // like `git diff --output=<path>`. Do not re-add git prefixes here: that would
  // re-allowlist those writes.
  "npm test",
  "pnpm test",
  "pnpm lint",
  "pnpm build",
  "pnpm typecheck",
  "pytest",
  "go test",
  "cargo test",
  "node --test",
];

const TEST_RUNNER_PREFIXES = [
  "npm test",
  "pnpm test",
  "yarn test",
  "npm run test",
  "pnpm run test",
  "pytest",
  "go test",
  "cargo test",
  "node --test",
  "vitest",
  "jest",
];

const BUILD_PREFIXES = ["pnpm build", "npm run build", "yarn build", "cargo build", "go build", "make", "tsc"];

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const TEST_COMMAND_TIMEOUT_MS = 120_000;
export const BUILD_COMMAND_TIMEOUT_MS = 180_000;

function matchesPrefix(normalized: string, prefix: string): boolean {
  return normalized === prefix || normalized.startsWith(prefix + " ");
}

/**
 * GitHub CLI (`gh`) and git classification.
 *
 * Read-only operations talk to the remote but only *fetch* data, so they are
 * safe to auto-run (classified "readonly"/L0) the same way `git status` and
 * `git diff` are auto-allowed. Mutating operations (create/merge/clone, writing
 * the worktree, or any non-GET `gh api`) fall through to "execute"/L2 and must
 * be confirmed — and the raw command is surfaced in the prompt (run_command
 * already passes `command` to confirm). Unknown subcommands default to the SAFE
 * side ("execute", confirm) rather than auto-allow.
 *
 * gh subcommand → permission
 *   issue   view | list                                  → readonly
 *   issue   create | close | reopen | comment | edit | delete | transfer
 *   issue   develop | lock | unlock | pin | unpin        → execute (confirm)
 *   pr      view | list | diff | checks | status         → readonly
 *   pr      create | merge | close | reopen | comment | edit | ready
 *   pr      checkout (writes worktree) | review          → execute (confirm)
 *   repo    view | list                                  → readonly
 *   repo    clone | fork | create | delete | rename ...  → execute (confirm)
 *   release view | list                                  → readonly
 *   release create | upload | delete | edit              → execute (confirm)
 *   auth    status                                       → readonly
 *   api     (GET: default, or --method/-X GET, no -f/-F/--input write) → readonly
 *   api     (-X/--method POST|PUT|PATCH|DELETE, or -f/-F/--input)      → execute
 *   <anything else / unknown>                            → execute (confirm)
 *
 * git subcommand → permission
 *   status | diff | log | show | branch (read, no mutate flag)
 *   fetch | remote -v | rev-parse | describe | tag (list) | stash list → readonly
 *   push | reset --hard | clean                          → dangerous (denylist)
 *   commit | merge | rebase | checkout -b | add ...      → execute (confirm)
 */

/** Read-only `gh <noun> <verb>` pairs (auto-allowed). */
const GH_READONLY: ReadonlySet<string> = new Set([
  "issue view",
  "issue list",
  "issue status",
  "pr view",
  "pr list",
  "pr diff",
  "pr checks",
  "pr status",
  "repo view",
  "repo list",
  "release view",
  "release list",
  "auth status",
  "search issues",
  "search prs",
  "search repos",
  "search code",
  "workflow view",
  "workflow list",
  "run view",
  "run list",
  "label list",
  "gist view",
  "gist list",
]);

/**
 * Classify a `gh` command line (already normalized, tokens[0] === "gh").
 * Returns "readonly" for safe reads, "execute" for everything else
 * (mutations and unknown subcommands — the safe default).
 */
function classifyGh(tokens: string[]): CommandPermission {
  const noun = tokens[1];
  if (noun === undefined) return "execute"; // bare `gh` — confirm

  if (noun === "api") {
    // GET is the default and is read-only; any write method or a field/body
    // flag (-f/-F/--field/--raw-field/--input) means a mutation.
    const hasWriteField = tokens.some(
      (t) =>
        t === "-f" ||
        t === "-F" ||
        t === "--field" ||
        t === "--raw-field" ||
        t === "--input" ||
        t.startsWith("--field=") ||
        t.startsWith("--raw-field=") ||
        t.startsWith("--input="),
    );
    if (hasWriteField) return "execute";
    const methods: string[] = [];
    for (let i = 2; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token === "-X" || token === "--method") {
        const method = tokens[i + 1];
        if (!method) return "execute";
        methods.push(method.toLowerCase());
        i++;
      } else if (token.startsWith("--method=")) {
        methods.push(token.slice("--method=".length).toLowerCase());
      } else if (token.startsWith("-X") && token.length > 2) {
        methods.push(token.slice(2).toLowerCase());
      }
    }
    if (methods.length > 0) return methods.every((method) => method === "get") ? "readonly" : "execute";
    return "readonly"; // no method flag → GET
  }

  const verb = tokens[2];
  if (verb !== undefined && GH_READONLY.has(`${noun} ${verb}`)) {
    return "readonly";
  }
  return "execute"; // unknown / mutating subcommand → confirm (safe default)
}

/** Read-only git subcommands (auto-allowed when no mutating flag is present). */
const GIT_READONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "diff",
  "log",
  "show",
  "fetch",
  "rev-parse",
  "describe",
  "shortlog",
  "blame",
  "ls-files",
  "ls-remote",
  "cat-file",
  "reflog",
  "whatchanged",
]);

/**
 * Classify a `git` command line (normalized, tokens[0] === "git"). Returns
 * "readonly" for inspection commands, "execute" for mutations (commit, merge,
 * checkout, add, …). Destructive git (push, reset --hard, clean) is handled by
 * the denylist before this is reached. Returns null when git is not read-only
 * AND not a recognized mutation case worth special handling — caller falls
 * through to the generic "execute" path.
 */
function classifyGit(tokens: string[]): CommandPermission {
  const sub = tokens[1];
  if (sub === undefined) return "execute";

  // `git diff --output=/abs/path` (and -o) writes an arbitrary file even though
  // diff is "read-only" — keep it off the auto-run fast-path so the write is
  // confirmed. `--output` never appears in a genuine inspection command.
  if (tokens.some((t) => t === "--output" || t.startsWith("--output=") || t === "-o")) {
    return "execute";
  }

  if (GIT_READONLY_SUBCOMMANDS.has(sub)) return "readonly";

  // `git branch`/`git tag`/`git stash`/`git remote`: read-only only in their
  // listing form; a write argument (e.g. `git branch -D x`, `git tag v1`)
  // makes them mutations.
  if (sub === "branch" || sub === "tag" || sub === "remote") {
    const args = tokens.slice(2);
    const listOnly =
      args.length === 0 ||
      args.every(
        (a) => a === "-v" || a === "-vv" || a === "-a" || a === "-r" || a === "-l" || a === "--list" || a === "list",
      );
    return listOnly ? "readonly" : "execute";
  }
  // `git stash` is special: bare `git stash` is `git stash push` — it MUTATES the
  // working tree. Only the explicit `git stash list` form is read-only (empty
  // args must NOT be treated as a listing here).
  if (sub === "stash") {
    const args = tokens.slice(2);
    const listOnly = args.length > 0 && args.every((a) => a === "list" || a === "-v" || a === "-vv");
    return listOnly ? "readonly" : "execute";
  }

  return "execute"; // commit, merge, rebase, checkout, add, … → confirm
}

export function classifyCommand(command: string, extraAllowlist: readonly string[] = []): CommandClassification {
  const normalized = normalizeCommand(command);

  const gitPolicy = classifyGitPolicy(command);
  if (gitPolicy.dangerous) {
    return {
      permission: "dangerous",
      allowlisted: false,
      defaultTimeoutMs: 0,
      reason: gitPolicy.dangerous,
    };
  }

  for (const { re, reason } of DENYLIST) {
    if (re.test(normalized)) {
      return { permission: "dangerous", allowlisted: false, defaultTimeoutMs: 0, reason };
    }
  }
  if (gitPolicy.pushes) {
    return {
      permission: "env",
      allowlisted: false,
      defaultTimeoutMs: BUILD_COMMAND_TIMEOUT_MS,
      reason: "git push",
    };
  }
  for (const { re, reason } of ENV_PATTERNS) {
    if (re.test(normalized)) {
      return {
        permission: "env",
        allowlisted: false,
        defaultTimeoutMs: BUILD_COMMAND_TIMEOUT_MS,
        reason,
      };
    }
  }

  // gh / git: read-only forms auto-run (L0); mutating/unknown forms fall
  // through to the generic "execute" path below so they confirm and surface the
  // raw command. Only inspect single, unpiped commands — a compound line keeps
  // the conservative generic treatment.
  const tokens = normalized.split(" ");
  // Only single, unpiped commands qualify for the read-only fast-path. Test the
  // ORIGINAL command, not the normalized one: normalizeCommand collapses \n/\r
  // into spaces, so a newline-separated sequence like "git log\nenv" would
  // otherwise look like a lone read-only "git log" yet execute `env` too when
  // handed to `/bin/sh -c`. Backticks and $(...) inject commands the same way.
  // Redirects (`>`, `>>`, `<`) never inject a command but let a "read-only"
  // form clobber/read an arbitrary file (`git log > ~/.zshrc`), so they also
  // disqualify the fast-path.
  const injectsCommands = hasShellControlSyntax(command);
  if (!injectsCommands) {
    if (tokens[0] === "gh" && classifyGh(tokens) === "readonly") {
      return {
        permission: "readonly",
        allowlisted: true,
        defaultTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        reason: "gh read-only",
      };
    }
    if (tokens[0] === "git" && classifyGit(tokens) === "readonly") {
      return {
        permission: "readonly",
        allowlisted: true,
        defaultTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        reason: "git read-only",
      };
    }
  }

  // `rg` is allowlisted, but its preprocessor / unrestricted-read flags would
  // make an auto-run into code execution or a protected-file read — those forms
  // must confirm instead.
  const rgUnsafe =
    tokens[0] === "rg" &&
    (RG_UNSAFE_FLAGS.test(normalized) ||
      referencesSensitivePath(tokens.slice(1)) ||
      referencesUnboundedPath(tokens.slice(1)));
  const allowlisted =
    !injectsCommands &&
    !rgUnsafe &&
    (BUILTIN_COMMAND_ALLOWLIST.some((p) => matchesPrefix(normalized, p)) ||
      extraAllowlist.some((p) => matchesPrefix(normalized, normalizeCommand(p))));

  let defaultTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;
  if (TEST_RUNNER_PREFIXES.some((p) => matchesPrefix(normalized, p))) {
    defaultTimeoutMs = TEST_COMMAND_TIMEOUT_MS;
  } else if (BUILD_PREFIXES.some((p) => matchesPrefix(normalized, p))) {
    defaultTimeoutMs = BUILD_COMMAND_TIMEOUT_MS;
  }

  return { permission: "execute", allowlisted, defaultTimeoutMs, reason: "execute" };
}

export type ShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

/** Cap raw capture so a chatty process cannot exhaust memory; tools re-truncate for output. */
const MAX_CAPTURE_CHARS = 2_000_000;
/**
 * After the shell process exits, wait this long for its stdout/stderr pipes to
 * reach EOF (the "close" event). If a detached descendant inherited the pipes
 * and holds them open past this grace, reap the process group and report the
 * real exit code instead of stalling to the command timeout.
 */
const EXIT_DRAIN_GRACE_MS = 100;

export type RunShellOptions = {
  /** OS-level sandbox; "off"/absent = plain /bin/sh (current behavior). */
  sandbox?: SandboxLevel | undefined;
  /** Workspace root the sandbox allows writes in. Defaults to `cwd`. */
  workspace?: string | undefined;
  /**
   * Live output observer, fired once per data chunk (decoded utf8) as the
   * command runs, in arrival order, unthrottled. Observer errors are
   * swallowed: a broken listener must never break the command.
   */
  onOutput?: ((stream: "stdout" | "stderr", chunk: string) => void) | undefined;
  /** Cooperative cancellation; abort kills the whole command process group. */
  signal?: AbortSignal | undefined;
};

/**
 * Output substrings (case-insensitive) that typically mean the OS sandbox —
 * not the command itself — caused a failure (seatbelt/bwrap write or network
 * denial). Used to decide whether to offer an unsandboxed retry.
 */
const SANDBOX_DENIAL_PATTERNS: readonly string[] = [
  "operation not permitted",
  "read-only file system",
  "eperm",
  "eacces",
  "network is unreachable",
  "sandbox",
];

/** True when a failed command's combined output looks like an OS-sandbox denial. */
export function looksLikeSandboxDenial(output: string): boolean {
  const lower = output.toLowerCase();
  return SANDBOX_DENIAL_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Run `command` through /bin/sh -c in its own process group so the whole
 * tree can be killed on timeout. Throws ToolError("timeout") when exceeded.
 * With options.sandbox set, wraps the shell in the OS sandbox (seatbelt /
 * bwrap); throws ToolError("sandbox_unavailable") instead of silently
 * running unsandboxed when the wrapper cannot be built.
 */
export function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  options: RunShellOptions = {},
): Promise<ShellResult> {
  const { sandbox, workspace = cwd, onOutput, signal } = options;
  if (signal?.aborted) {
    return Promise.reject(new ToolError("cancelled", "Command cancelled"));
  }
  if (sandbox !== undefined && sandbox !== "off" && buildSandboxSpec(sandbox, workspace) === null) {
    return Promise.reject(
      new ToolError("sandbox_unavailable", "sandbox requested but sandbox-exec/bwrap not found on this system"),
    );
  }
  const shell = sandboxedShell(command, sandbox, workspace);
  const started = Date.now();
  return new Promise<ShellResult>((resolve, reject) => {
    const child = spawn(shell.bin, shell.args, {
      cwd,
      detached: true, // own process group -> tree kill on timeout
      stdio: ["ignore", "pipe", "pipe"],
      env: scrubSecretEnv(), // don't leak the provider API key / tokens to commands
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    // Decode per stream through a StringDecoder so a multi-byte UTF-8 sequence
    // split across two `data` chunks isn't turned into U+FFFD replacement
    // characters — it buffers the incomplete tail until the next chunk.
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");

    const observe = (stream: "stdout" | "stderr", text: string): void => {
      if (onOutput === undefined || text === "") return;
      try {
        onOutput(stream, text);
      } catch {
        // observers must never break the command
      }
    };

    child.stdout.on("data", (c: Buffer) => {
      const text = outDecoder.write(c);
      if (stdout.length < MAX_CAPTURE_CHARS) {
        stdout += text;
        if (stdout.length > MAX_CAPTURE_CHARS) stdout = stdout.slice(0, MAX_CAPTURE_CHARS);
      }
      observe("stdout", text);
    });
    child.stderr.on("data", (c: Buffer) => {
      const text = errDecoder.write(c);
      if (stderr.length < MAX_CAPTURE_CHARS) {
        stderr += text;
        if (stderr.length > MAX_CAPTURE_CHARS) stderr = stderr.slice(0, MAX_CAPTURE_CHARS);
      }
      observe("stderr", text);
    });
    // A pipe error (e.g. EPIPE during SIGKILL teardown) with no listener is an
    // uncaught exception that takes down the whole process; the child's own
    // error/close handlers below already report the failure.
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    const killTree = (): void => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    let timer: ReturnType<typeof setTimeout>;
    let offAbort: () => void = () => {};
    let exitGrace: ReturnType<typeof setTimeout> | undefined;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitGrace) clearTimeout(exitGrace);
      offAbort();
      child.removeAllListeners("error");
      child.removeAllListeners("close");
      child.removeAllListeners("exit");
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
      fn();
    };

    const settleTerminalError = (kind: "cancelled" | "timeout"): void =>
      settle(() => {
        if (kind === "cancelled") {
          reject(new ToolError("cancelled", "Command cancelled", { stdout, stderr }));
        } else {
          reject(
            new ToolError("timeout", `Command timed out after ${timeoutMs}ms`, {
              timeoutMs,
              stdout,
              stderr,
            }),
          );
        }
      });

    timer = setTimeout(() => {
      killTree();
      settleTerminalError("timeout");
    }, timeoutMs);
    // onAbortOnce fires immediately on an already-aborted signal, closing the
    // check→subscribe race.
    offAbort = onAbortOnce(signal, () => {
      killTree();
      settleTerminalError("cancelled");
    });

    const finishNormally = (code: number | null): void =>
      settle(() => {
        // Flush any bytes the decoders buffered mid-sequence at stream end.
        const outTail = outDecoder.end();
        const errTail = errDecoder.end();
        if (outTail && stdout.length < MAX_CAPTURE_CHARS) stdout += outTail;
        if (errTail && stderr.length < MAX_CAPTURE_CHARS) stderr += errTail;
        const durationMs = Date.now() - started;
        resolve({ exitCode: code ?? -1, stdout, stderr, durationMs });
      });

    child.on("error", (err) => settle(() => reject(new ToolError("spawn_failed", err.message))));
    // Fast path: the pipes reach EOF (no lingering holders) and we settle with
    // the full output.
    child.on("close", (code) => finishNormally(code));
    // The shell process itself exited. "close" normally follows immediately,
    // but a detached descendant that inherited the stdout/stderr pipe keeps it
    // open, so "close" never fires. Wait a short grace for a clean drain, then
    // reap the process group and settle with the real exit code — otherwise the
    // run stalls to `timeoutMs` and is mislabeled a timeout.
    child.on("exit", (code) => {
      if (settled || exitGrace) return;
      exitGrace = setTimeout(() => {
        killTree();
        finishNormally(code);
      }, EXIT_DRAIN_GRACE_MS);
      exitGrace.unref();
    });
  });
}
