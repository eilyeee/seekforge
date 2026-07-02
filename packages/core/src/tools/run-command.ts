import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { ToolError } from "./errors.js";
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
  { re: /\bgit\s+reset\s+--hard\b/, reason: "git reset --hard" },
  { re: /\bgit\s+clean\b/, reason: "git clean" },
  { re: /\bgit\s+push\b/, reason: "git push" },
  { re: /\b(curl|wget)\b[^|;&]*\|\s*([^\s|;&]+\s+)*(sh|bash|zsh)\b/, reason: "download piped to shell" },
  { re: /\b(bash|sh)\s+-c\b/, reason: "nested shell -c" },
  { re: /\bnode\s+(-[^\s]+\s+)*(-e|--eval)\b/, reason: "node -e" },
  { re: /\bpython3?\s+(-[^\s]+\s+)*-c\b/, reason: "python -c" },
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
  "git status",
  "git diff",
  "git log",
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

/** Mutating-API method flags on `gh api`. */
const GH_API_WRITE_METHOD = /\b(post|put|patch|delete)\b/;

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
      (t) => t === "-f" || t === "-F" || t === "--field" || t === "--raw-field" || t === "--input",
    );
    if (hasWriteField) return "execute";
    const mIdx = tokens.findIndex((t) => t === "-X" || t === "--method");
    if (mIdx !== -1) {
      const method = (tokens[mIdx + 1] ?? "").toLowerCase();
      return GH_API_WRITE_METHOD.test(method) ? "execute" : "readonly";
    }
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

  if (GIT_READONLY_SUBCOMMANDS.has(sub)) return "readonly";

  // `git branch`/`git tag`/`git stash`/`git remote`: read-only only in their
  // listing form; a write argument (e.g. `git branch -D x`, `git tag v1`)
  // makes them mutations.
  if (sub === "branch" || sub === "tag" || sub === "remote") {
    const args = tokens.slice(2);
    const listOnly =
      args.length === 0 ||
      args.every((a) => a === "-v" || a === "-vv" || a === "-a" || a === "-r" || a === "-l" || a === "--list" || a === "list");
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

export function classifyCommand(
  command: string,
  extraAllowlist: readonly string[] = [],
): CommandClassification {
  const normalized = normalizeCommand(command);

  for (const { re, reason } of DENYLIST) {
    if (re.test(normalized)) {
      return { permission: "dangerous", allowlisted: false, defaultTimeoutMs: 0, reason };
    }
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
  const injectsCommands = /[|&;<>\n\r`]/.test(command) || command.includes("$(");
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

  const allowlisted =
    BUILTIN_COMMAND_ALLOWLIST.some((p) => matchesPrefix(normalized, p)) ||
    extraAllowlist.some((p) => matchesPrefix(normalized, normalizeCommand(p)));

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
  const { sandbox, workspace = cwd, onOutput } = options;
  if (sandbox !== undefined && sandbox !== "off" && buildSandboxSpec(sandbox, workspace) === null) {
    return Promise.reject(
      new ToolError(
        "sandbox_unavailable",
        "sandbox requested but sandbox-exec/bwrap not found on this system",
      ),
    );
  }
  const shell = sandboxedShell(command, sandbox, workspace);
  const started = Date.now();
  return new Promise<ShellResult>((resolve, reject) => {
    const child = spawn(shell.bin, shell.args, {
      cwd,
      detached: true, // own process group -> tree kill on timeout
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
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

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, timeoutMs);

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.on("error", (err) => settle(() => reject(new ToolError("spawn_failed", err.message))));
    child.on("close", (code) =>
      settle(() => {
        // Flush any bytes the decoders buffered mid-sequence at stream end.
        const outTail = outDecoder.end();
        const errTail = errDecoder.end();
        if (outTail && stdout.length < MAX_CAPTURE_CHARS) stdout += outTail;
        if (errTail && stderr.length < MAX_CAPTURE_CHARS) stderr += errTail;
        const durationMs = Date.now() - started;
        if (timedOut) {
          reject(
            new ToolError("timeout", `Command timed out after ${timeoutMs}ms`, {
              timeoutMs,
              stdout,
              stderr,
            }),
          );
          return;
        }
        resolve({ exitCode: code ?? -1, stdout, stderr, durationMs });
      }),
    );
  });
}
