/**
 * Workspace terminal over WebSocket (path /ws/terminal, SERVER-API.md).
 *
 * A real PTY without a native dependency: the shell runs under the system
 * `script` utility (BSD syntax on macOS, util-linux syntax elsewhere). macOS
 * `script` refuses a socket as stdin (EOPNOTSUPP) but accepts a plain pipe
 * (ENOTTY), and Node hands children sockets, so input is bridged through
 * `cat |`. A tiny in-PTY prelude sizes the terminal and reports its device
 * path in a private OSC sequence that is stripped here; later resizes are
 * best effort via `stty` on that device. Without `script` the shell runs on
 * plain pipes (`pty: false`).
 *
 * Every terminal is bound to one authenticated socket: closing the socket (or
 * the server) kills the whole process group.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import type { RawData, WebSocket } from "ws";

export const MAX_TERMINALS = 8;
export const MAX_TERMINAL_INPUT_CHARS = 64_000;
const OUTPUT_FLUSH_MS = 16;
const HIGH_WATER_BYTES = 8_000_000;
const LOW_WATER_BYTES = 1_000_000;
const MARKER_WAIT_MS = 3_000;
const MARKER_MAX_CHARS = 64_000;
const KILL_GRACE_MS = 2_000;
const TTY_MARKER_RE = /\u001b\]1337;SeekForgeTty=([^\u0007\u001b]*)\u0007/;
const TTY_PATH_RE = /^\/dev\/(?:ttys\d{1,4}|pts\/\d{1,6}|tty[a-zA-Z0-9]{1,8})$/;

export type TerminalAvailability =
  | { available: true; shell: string; pty: boolean }
  | { available: false; reason: string };

export type TerminalClientFrame = { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };

export type TerminalServerFrame =
  | { type: "ready"; shell: string; cwd: string; pty: boolean }
  | { type: "output"; data: string }
  | { type: "exit"; code: number | null; signal: string | null }
  | { type: "error"; code: string; message: string };

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir !== "" && isExecutable(join(dir, name))) return join(dir, name);
  }
  for (const dir of ["/usr/bin", "/bin"]) {
    if (isExecutable(join(dir, name))) return join(dir, name);
  }
  return undefined;
}

/** The user's shell when it is a usable absolute path, else a POSIX fallback. */
export function resolveShell(env: NodeJS.ProcessEnv = process.env): string {
  const preferred = env.SHELL;
  if (preferred && isAbsolute(preferred) && isExecutable(preferred)) return preferred;
  return ["/bin/bash", "/bin/zsh", "/bin/sh"].find(isExecutable) ?? "/bin/sh";
}

export function terminalAvailability(enabled: boolean): TerminalAvailability {
  if (!enabled) return { available: false, reason: "the terminal is disabled on this server" };
  if (process.platform === "win32") return { available: false, reason: "the terminal is not supported on Windows" };
  if (!existsSync("/bin/sh")) return { available: false, reason: "no /bin/sh on this system" };
  return { available: true, shell: resolveShell(), pty: findOnPath("script") !== undefined };
}

/** Login + interactive flags only for shells known to accept both. */
function shellFlags(shell: string): string {
  return ["bash", "zsh", "fish", "ksh"].includes(basename(shell)) ? "-l -i" : "-i";
}

/**
 * The spawn line for one terminal. Exported for tests; the prelude runs inside
 * the PTY, so `stty` sizes the PTY itself and `tty` names its device.
 */
export function terminalCommand(
  shell: string,
  platform: NodeJS.Platform,
  pty: boolean,
  size: { cols: number; rows: number },
): { command: string; args: string[]; env: Record<string, string> } {
  // Values travel in the environment, never spliced into the script text.
  const env = { SF_SHELL: shell, SF_COLS: String(size.cols), SF_ROWS: String(size.rows) };
  const launch = `s="$SF_SHELL"; unset SF_COLS SF_ROWS SF_SHELL SF_INNER; exec "$s"`;
  if (!pty) return { command: "/bin/sh", args: ["-c", `${launch} -i`], env };
  const inner =
    `stty cols "$SF_COLS" rows "$SF_ROWS" 2>/dev/null; ` +
    `printf '\\033]1337;SeekForgeTty=%s\\007' "$(tty)"; ` +
    `${launch} ${shellFlags(shell)}`;
  const bsd = platform === "darwin" || platform === "freebsd" || platform === "openbsd";
  const script = bsd
    ? `exec script -q /dev/null /bin/sh -c "$SF_INNER"`
    : `exec script -qfc '/bin/sh -c "$SF_INNER"' /dev/null`;
  return { command: "/bin/sh", args: ["-c", `cat | ${script}`], env: { ...env, SF_INNER: inner } };
}

/** Decodes one client frame; anything else is refused. */
export function parseTerminalFrame(text: string): TerminalClientFrame | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "frames must be JSON objects" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { error: "frames must be JSON objects" };
  const frame = value as Record<string, unknown>;
  if (frame.type === "input") {
    if (typeof frame.data !== "string" || frame.data.length > MAX_TERMINAL_INPUT_CHARS) {
      return { error: `input.data must be a string of at most ${MAX_TERMINAL_INPUT_CHARS} characters` };
    }
    return { type: "input", data: frame.data };
  }
  if (frame.type === "resize") {
    const { cols, rows } = frame;
    if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows))
      return { error: "resize needs integer cols and rows" };
    if ((cols as number) < 2 || (cols as number) > 500 || (rows as number) < 2 || (rows as number) > 300) {
      return { error: "resize cols must be 2-500 and rows 2-300" };
    }
    return { type: "resize", cols: cols as number, rows: rows as number };
  }
  return { error: `unknown frame type: ${String(frame.type)}` };
}

function clampSize(value: string | null, fallback: number, max: number): number {
  const parsed = value === null ? Number.NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 2 && parsed <= max ? parsed : fallback;
}

export type TerminalDeps = {
  /** Workspace directory the shell starts in. */
  cwd: string;
  cols: string | null;
  rows: string | null;
  /** Registers the child's lifetime so server shutdown waits for it. */
  track: (exited: Promise<void>) => void;
  /** Live terminal count, shared across connections. */
  active: Set<ChildProcess>;
};

export function handleTerminalConnection(ws: WebSocket, deps: TerminalDeps): void {
  ws.on("error", () => {});
  const send = (frame: TerminalServerFrame): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame), () => {});
  };
  const availability = terminalAvailability(true);
  if (!availability.available) {
    send({ type: "error", code: "unavailable", message: availability.reason });
    ws.close(1011, "terminal unavailable");
    return;
  }
  if (deps.active.size >= MAX_TERMINALS) {
    send({ type: "error", code: "too_many_terminals", message: `at most ${MAX_TERMINALS} terminals may be open` });
    ws.close(1013, "too many terminals");
    return;
  }

  const cols = clampSize(deps.cols, 100, 500);
  const rows = clampSize(deps.rows, 30, 300);
  const { command, args, env } = terminalCommand(availability.shell, process.platform, availability.pty, {
    cols,
    rows,
  });
  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      cwd: deps.cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        COLUMNS: String(cols),
        LINES: String(rows),
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so one signal reaches cat, script and the shell.
      detached: true,
    });
  } catch (error) {
    send({ type: "error", code: "spawn_failed", message: error instanceof Error ? error.message : String(error) });
    ws.close(1011, "spawn failed");
    return;
  }
  deps.active.add(child);

  let ttyPath: string | undefined;
  let awaitingMarker = availability.pty;
  let pending = "";
  let flushTimer: NodeJS.Timeout | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  let exited = false;
  let killTimer: NodeJS.Timeout | undefined;

  const flush = (): void => {
    flushTimer = undefined;
    if (pending === "" || awaitingMarker) return;
    const data = pending;
    pending = "";
    send({ type: "output", data });
    if (ws.bufferedAmount > HIGH_WATER_BYTES && !drainTimer) {
      child.stdout?.pause();
      child.stderr?.pause();
      drainTimer = setInterval(() => {
        if (ws.readyState !== ws.OPEN || ws.bufferedAmount < LOW_WATER_BYTES) {
          clearInterval(drainTimer);
          drainTimer = undefined;
          child.stdout?.resume();
          child.stderr?.resume();
        }
      }, 50);
      drainTimer.unref();
    }
  };
  const releaseMarker = (): void => {
    if (!awaitingMarker) return;
    const match = TTY_MARKER_RE.exec(pending);
    if (match) {
      if (TTY_PATH_RE.test(match[1] ?? "")) ttyPath = match[1];
      pending = pending.slice(0, match.index) + pending.slice(match.index + match[0].length);
    }
    awaitingMarker = false;
    flush();
  };
  const markerTimer = awaitingMarker ? setTimeout(releaseMarker, MARKER_WAIT_MS) : undefined;
  markerTimer?.unref();

  const onOutput = (chunk: string): void => {
    pending += chunk;
    if (awaitingMarker) {
      if (TTY_MARKER_RE.test(pending) || pending.length > MARKER_MAX_CHARS) {
        clearTimeout(markerTimer);
        releaseMarker();
      }
      return;
    }
    if (!flushTimer) flushTimer = setTimeout(flush, OUTPUT_FLUSH_MS);
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", onOutput);
  child.stderr?.on("data", onOutput);
  child.stdin?.on("error", () => {});

  const killGroup = (signal: NodeJS.Signals): void => {
    if (exited || child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
  };

  const exitedPromise = new Promise<void>((resolveExit) => {
    child.once("close", (code, signal) => {
      exited = true;
      deps.active.delete(child);
      clearTimeout(markerTimer);
      clearTimeout(killTimer);
      if (drainTimer) clearInterval(drainTimer);
      awaitingMarker = false;
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      send({ type: "exit", code, signal });
      if (ws.readyState === ws.OPEN) ws.close(1000, "terminal exited");
      resolveExit();
    });
    child.once("error", (error) => {
      send({ type: "error", code: "spawn_failed", message: error.message });
      if (!exited) {
        exited = true;
        deps.active.delete(child);
        clearTimeout(markerTimer);
        if (ws.readyState === ws.OPEN) ws.close(1011, "spawn failed");
        resolveExit();
      }
    });
  });
  deps.track(exitedPromise);

  send({ type: "ready", shell: availability.shell, cwd: deps.cwd, pty: availability.pty });

  let resizeTimer: NodeJS.Timeout | undefined;
  const resize = (nextCols: number, nextRows: number): void => {
    if (!ttyPath) return;
    const device = ttyPath;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const flag = process.platform === "linux" ? "-F" : "-f";
      execFile("stty", [flag, device, "cols", String(nextCols), "rows", String(nextRows)], { timeout: 5_000 }, () => {
        // Best effort: a failed resize leaves the previous size in place.
      });
    }, 100);
    resizeTimer.unref();
  };

  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      send({ type: "error", code: "bad_frame", message: "frames must be UTF-8 JSON text" });
      return;
    }
    const frame = parseTerminalFrame(String(data));
    if ("error" in frame) {
      send({ type: "error", code: "bad_frame", message: frame.error });
      return;
    }
    if (frame.type === "input") {
      if (!exited && child.stdin?.writable) child.stdin.write(frame.data);
      return;
    }
    resize(frame.cols, frame.rows);
  });

  ws.on("close", () => {
    clearTimeout(resizeTimer);
    if (exited) return;
    child.stdin?.end();
    killGroup("SIGHUP");
    killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
  });
}
