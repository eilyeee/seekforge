const childProcess = require("node:child_process");

/**
 * `seekforge serve` prints `http://127.0.0.1:<port>/?token=<token>` once it is
 * listening (the surrounding words are localized; the URL is not). The token
 * is `randomBytes(24).toString("base64url")`.
 */
const SERVE_URL_RE = /http:\/\/127\.0\.0\.1:(\d{1,5})\/\?token=([A-Za-z0-9_-]{16,256})/;
const READY_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 5_000;
const MAX_CAPTURED_CHARS = 64_000;

function parseServeUrl(text) {
  const match = SERVE_URL_RE.exec(String(text ?? ""));
  if (!match) return undefined;
  const port = Number(match[1]);
  return port > 0 && port <= 65_535 ? { port, token: match[2] } : undefined;
}

/** The token must not sit in a terminal someone may be screen-sharing. */
function maskServeToken(text) {
  return String(text).replace(new RegExp(SERVE_URL_RE.source, "g"), "http://127.0.0.1:$1/?token=<saved to VS Code>");
}

/**
 * On Windows the npm shim is a `.cmd`, which Node only runs through a shell.
 * cmd.exe has no quoting that neutralises every metacharacter, so such an
 * argument is refused instead of being passed along.
 */
function windowsSafeArgument(value) {
  return /^[A-Za-z0-9_\-.:\\/ ()]+$/.test(value);
}

/**
 * The argv for serving these folders on `port`. Folder paths travel as
 * separate arguments — never through a shell string — except on Windows, where
 * unsafe ones are dropped and reported.
 */
function serveInvocation({ command, folders, port, platform = process.platform }) {
  const skipped = [];
  const usable = folders.filter((folder) => {
    const ok = platform !== "win32" || windowsSafeArgument(folder);
    if (!ok) skipped.push(folder);
    return ok;
  });
  const args = ["serve", ...usable, "--port", String(port)];
  if (platform !== "win32") return { command, args, shell: false, skipped };
  if (!windowsSafeArgument(command)) throw new Error(`Refusing to run ${command} through cmd.exe`);
  return { command: `"${command}"`, args: args.map((arg) => `"${arg}"`), shell: true, skipped };
}

/**
 * One `seekforge serve` child. It is owned from the instant `spawn` returns:
 * error and exit listeners are attached before anything can fail, `ready`
 * settles exactly once, and `stop` escalates to SIGKILL after a grace period.
 */
class ServeProcess {
  constructor({ command, args, shell = false, cwd, env = process.env, spawn = childProcess.spawn, readyTimeoutMs }) {
    this.output = "";
    this.listeners = new Set();
    this.exitListeners = new Set();
    this.exited = false;
    this.exitCode = null;
    let settleReady;
    this.ready = new Promise((resolve, reject) => {
      settleReady = { resolve, reject };
    });
    let settled = false;
    let timer;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) settleReady.reject(error);
      else settleReady.resolve(value);
    };
    // Nobody may be awaiting `ready` when the process dies; that is not an unhandled rejection.
    this.ready.catch(() => {});

    this.child = spawn(command, args, { cwd, env, shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    timer = setTimeout(
      () => settle(new Error("seekforge serve did not report its address within 60 seconds")),
      readyTimeoutMs ?? READY_TIMEOUT_MS,
    );
    // Listeners get whole lines only, so a token split across two chunks is
    // still masked. An unterminated line is released when the process exits.
    const partial = { stdout: "", stderr: "" };
    const emit = (text) => {
      if (text === "") return;
      for (const listener of this.listeners) listener(maskServeToken(text));
    };
    const onChunk = (stream) => (chunk) => {
      const text = String(chunk);
      this.output = `${this.output}${text}`.slice(-MAX_CAPTURED_CHARS);
      const lines = `${partial[stream]}${text}`.split("\n");
      partial[stream] = lines.pop().slice(-MAX_CAPTURED_CHARS);
      if (lines.length > 0) emit(`${lines.join("\n")}\n`);
      const found = parseServeUrl(this.output);
      if (found) settle(undefined, found);
    };
    this.child.stdout?.on("data", onChunk("stdout"));
    this.child.stderr?.on("data", onChunk("stderr"));
    this.child.on("error", (error) => {
      this.exited = true;
      settle(error);
    });
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code ?? signal;
    });
    // 'close' follows 'exit' once the pipes are drained, so no output is lost.
    this.child.on("close", (code, signal) => {
      this.exited = true;
      emit(partial.stdout);
      emit(partial.stderr);
      partial.stdout = "";
      partial.stderr = "";
      settle(new Error(`seekforge serve exited (${code ?? signal}) before it was ready`));
      for (const listener of this.exitListeners) listener(code, signal);
    });
  }

  onOutput(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener) {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  stop() {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const kill = setTimeout(() => {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, STOP_GRACE_MS);
      this.child.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      try {
        this.child.kill("SIGTERM");
      } catch {
        clearTimeout(kill);
        resolve();
      }
    });
  }
}

module.exports = {
  ServeProcess,
  maskServeToken,
  parseServeUrl,
  serveInvocation,
  windowsSafeArgument,
};
