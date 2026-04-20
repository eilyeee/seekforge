import { spawn } from "node:child_process";
import { ToolError } from "./errors.js";
import { buildSandboxSpec, sandboxedShell, type SandboxLevel } from "./os-sandbox.js";

export type CommandPermission = "execute" | "env" | "dangerous";

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
  { re: /\brm\s+(-[^\s]+\s+)*-[^\s]*(rf|fr)[^\s]*\b/, reason: "rm -rf" },
  { re: /\brm\s+(-[^\s]+\s+)*-[^\s]*r[^\s]*\s+(-[^\s]+\s+)*-[^\s]*f[^\s]*\b/, reason: "rm -r -f" },
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
};

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
  const { sandbox, workspace = cwd } = options;
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

    const append = (cur: string, chunk: Buffer): string =>
      cur.length >= MAX_CAPTURE_CHARS ? cur : cur + chunk.toString("utf8");

    child.stdout.on("data", (c: Buffer) => (stdout = append(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = append(stderr, c)));

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
