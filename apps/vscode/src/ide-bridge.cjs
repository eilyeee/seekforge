const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

/**
 * The IDE bridge: a loopback HTTP server that lets a SeekForge process on this
 * machine (the TUI's /ide command) read the editor's context and ask the editor
 * to show a diff or open a file. Discovery is a lock file per server under
 * `~/.seekforge/ide/`, readable only by this user; every request must carry
 * that file's bearer token.
 *
 * Contract (version 1) — see docs/ide.md:
 *   lock   ~/.seekforge/ide/<port>.json  {version, port, token, pid, ideName, workspaceFolders}
 *   GET  /v1/context   → {activeFile?, selection?, openFiles, diagnostics}
 *   POST /v1/openDiff  {path, original, proposed, title?} → {ok: true}
 *   POST /v1/openFile  {path, line?}                      → {ok: true}
 */

const LOCK_VERSION = 1;
const LOCK_NAME_RE = /^(\d{1,5})\.json$/;
/** A lock file larger than this is not one we wrote. */
const MAX_LOCK_BYTES = 256 * 1024;
/** Two whole files travel in an openDiff body. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_TITLE_CHARS = 200;
const MAX_PATH_CHARS = 4_096;
const MAX_LINE = 100_000_000;
/** A lock without a readable pid may be mid-write by its owner; leave it alone this long. */
const MALFORMED_LOCK_GRACE_MS = 60_000;
/** How often the owner re-asserts its lock, in case a racing cleanup removed it. */
const LOCK_HEARTBEAT_MS = 30_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function lockDirectory(homeDir = os.homedir()) {
  return path.join(homeDir, ".seekforge", "ide");
}

/**
 * Creates the lock directory owner-only and refuses one that is a symlink or
 * belongs to someone else — a token written there would otherwise be readable
 * by whoever controls it.
 */
function ensurePrivateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (process.platform === "win32") return;
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${dir} is not owned by the current user`);
  }
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}

function readLockFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) return undefined;
    const buffer = Buffer.alloc(stat.size);
    const read = fs.readSync(fd, buffer, 0, stat.size, 0);
    const parsed = JSON.parse(buffer.subarray(0, read).toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** `process.kill(pid, 0)` probes without signalling; EPERM still means "exists". */
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Removes lock files whose owner process is gone. A file that cannot be parsed
 * is only removed once it is older than a grace period (its owner may be
 * mid-write), and nothing but regular `<port>.json` files is touched.
 *
 * PIDs are reused, so a crashed window's lock can survive while an unrelated
 * process holds its old pid; a client then fails to connect to that port and
 * moves on. The contract carries no process start identity to do better.
 */
function cleanupStaleLocks(dir, { now = Date.now(), isAlive = processAlive } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    if (!LOCK_NAME_RE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) continue;
      let lock;
      try {
        lock = readLockFile(file);
      } catch {
        lock = undefined;
      }
      const pid = lock?.pid;
      const stale = Number.isSafeInteger(pid) ? !isAlive(pid) : now - stat.mtimeMs > MALFORMED_LOCK_GRACE_MS;
      if (!stale) continue;
      // Re-check just before unlinking: a new owner that took the same port
      // may have replaced the file since it was read.
      const current = fs.lstatSync(file);
      if (current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs) continue;
      fs.unlinkSync(file);
      removed.push(name);
    } catch {
      // Best effort: a lock that vanished or cannot be read is not ours to fix.
    }
  }
  return removed;
}

/** Writes `data` to `file` owner-only, via a temp file and rename so readers never see half a lock. */
function writeLockFile(file, data) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** Deletes the lock only while it is still ours: another window may own the same name now. */
function removeLockIfOwned(file, token) {
  try {
    if (readLockFile(file)?.token === token) fs.unlinkSync(file);
  } catch {
    // Already gone or replaced.
  }
}

function tokenMatches(header, token) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length);
  // Hashing both sides gives equal-length buffers, so the comparison is constant-time.
  const a = crypto.createHash("sha256").update(presented).digest();
  const b = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * DNS-rebinding defense: a page on an attacker's domain that resolves to
 * 127.0.0.1 still sends its own name as Host. Only a loopback name with this
 * server's port is accepted.
 */
function hostAllowed(host, port) {
  if (typeof host !== "string") return false;
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(host.trim());
  return match !== null && LOOPBACK_HOSTS.has(match[1].toLowerCase()) && Number(match[2]) === port;
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(payload);
}

/**
 * Reads a JSON object body, counting bytes as they arrive so an oversized body
 * is refused before it is buffered. Listeners are detached on every terminal
 * path; an error sink stays attached until the request closes.
 */
function readJsonBody(req, limit) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.reject(new HttpError(413, "too_large", `body exceeds ${limit} bytes`));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("close", onClose);
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) settle(new HttpError(413, "too_large", `body exceeds ${limit} bytes`));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        settle(new HttpError(400, "bad_request", "body must be JSON"));
        return;
      }
      if (!isRecord(parsed)) settle(new HttpError(400, "bad_request", "body must be a JSON object"));
      else settle(undefined, parsed);
    };
    const onClose = () => settle(new HttpError(400, "bad_request", "request closed before its body ended"));
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("close", onClose);
    req.on("error", (error) => settle(error));
  });
}

function requireAbsolutePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_CHARS || value.includes("\0")) {
    throw new HttpError(400, "bad_request", "path must be a non-empty string");
  }
  if (!path.isAbsolute(value)) throw new HttpError(400, "bad_request", "path must be absolute");
  return path.normalize(value);
}

/** Decodes the openDiff body; unknown fields are ignored so newer clients keep working. */
function parseOpenDiff(body) {
  const target = requireAbsolutePath(body.path);
  if (typeof body.original !== "string" || typeof body.proposed !== "string") {
    throw new HttpError(400, "bad_request", "original and proposed must be strings");
  }
  if (body.title !== undefined && (typeof body.title !== "string" || body.title.length > MAX_TITLE_CHARS)) {
    throw new HttpError(400, "bad_request", `title must be a string of at most ${MAX_TITLE_CHARS} characters`);
  }
  return {
    path: target,
    original: body.original,
    proposed: body.proposed,
    ...(body.title ? { title: body.title } : {}),
  };
}

function parseOpenFile(body) {
  const target = requireAbsolutePath(body.path);
  if (body.line !== undefined && (!Number.isSafeInteger(body.line) || body.line < 1 || body.line > MAX_LINE)) {
    throw new HttpError(400, "bad_request", "line must be a positive integer");
  }
  return { path: target, ...(body.line !== undefined ? { line: body.line } : {}) };
}

const ROUTES = {
  "/v1/context": "GET",
  "/v1/openDiff": "POST",
  "/v1/openFile": "POST",
};

/**
 * Starts the bridge and writes its lock file. `handlers` are the editor-side
 * effects: `context()` returns the /v1/context body, `openDiff(input)` and
 * `openFile(input)` show things in the editor.
 */
async function startIdeBridge({
  handlers,
  ideName,
  workspaceFolders = () => [],
  homeDir = os.homedir(),
  pid = process.pid,
  token = crypto.randomBytes(32).toString("hex"),
  now = Date.now,
  isAlive = processAlive,
  maxBodyBytes = MAX_BODY_BYTES,
  heartbeatMs = LOCK_HEARTBEAT_MS,
}) {
  const dir = lockDirectory(homeDir);
  ensurePrivateDirectory(dir);
  cleanupStaleLocks(dir, { now: now(), isAlive });

  let port = 0;
  const handle = async (req, res) => {
    // Browsers attach Origin to cross-site fetches; a CLI never needs to.
    if (req.headers.origin !== undefined) throw new HttpError(403, "forbidden", "browser requests are not accepted");
    if (!hostAllowed(req.headers.host, port)) throw new HttpError(403, "forbidden", "unexpected Host header");
    if (!tokenMatches(req.headers.authorization, token)) {
      throw new HttpError(401, "unauthorized", "missing or invalid bearer token");
    }
    const pathname = (req.url ?? "").split("?")[0];
    const method = Object.hasOwn(ROUTES, pathname) ? ROUTES[pathname] : undefined;
    if (!method) throw new HttpError(404, "not_found", "unknown route");
    if (req.method !== method) {
      res.setHeader("allow", method);
      throw new HttpError(405, "method_not_allowed", `use ${method}`);
    }
    if (pathname === "/v1/context") {
      sendJson(res, 200, await handlers.context());
      return;
    }
    const body = await readJsonBody(req, maxBodyBytes);
    if (pathname === "/v1/openDiff") {
      await handlers.openDiff(parseOpenDiff(body));
      sendJson(res, 200, { ok: true });
      return;
    }
    const input = parseOpenFile(body);
    const stat = await fs.promises.stat(input.path).catch(() => undefined);
    if (!stat?.isFile()) throw new HttpError(404, "not_found", "no such file");
    await handlers.openFile(input);
    sendJson(res, 200, { ok: true });
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      const known = error instanceof HttpError;
      const status = known ? error.status : 500;
      // An unread body would otherwise keep the connection busy; close it once answered.
      const close = status === 413 || !req.complete;
      if (close) res.on("finish", () => req.destroy());
      sendJson(
        res,
        status,
        { error: known ? error.code : "internal", message: known ? error.message : "the editor could not do that" },
        close ? { connection: "close" } : {},
      );
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = server.address().port;
  const lockPath = path.join(dir, `${port}.json`);
  const lockData = () => ({
    version: LOCK_VERSION,
    port,
    token,
    pid,
    ideName,
    workspaceFolders: [...workspaceFolders()],
  });

  try {
    writeLockFile(lockPath, lockData());
  } catch (error) {
    server.close();
    throw error;
  }

  // Sync-only work on 'exit': the lock must not outlive the editor process.
  const onExit = () => removeLockIfOwned(lockPath, token);
  process.on("exit", onExit);
  const ensureLock = () => {
    try {
      if (readLockFile(lockPath)?.token === token) return;
    } catch {
      // Missing or unreadable: rewrite below.
    }
    try {
      writeLockFile(lockPath, lockData());
    } catch {
      // Retried on the next beat.
    }
  };
  const heartbeat = setInterval(ensureLock, heartbeatMs);
  heartbeat.unref?.();

  let closing;
  return {
    port,
    token,
    lockPath,
    /** Rewrites the lock after the window's folders change. */
    refresh() {
      if (closing) return;
      try {
        writeLockFile(lockPath, lockData());
      } catch {
        // The heartbeat retries.
      }
    },
    close() {
      closing ??= (async () => {
        clearInterval(heartbeat);
        process.off("exit", onExit);
        removeLockIfOwned(lockPath, token);
        await new Promise((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      })();
      return closing;
    },
  };
}

module.exports = {
  LOCK_VERSION,
  MALFORMED_LOCK_GRACE_MS,
  MAX_BODY_BYTES,
  cleanupStaleLocks,
  ensurePrivateDirectory,
  hostAllowed,
  lockDirectory,
  parseOpenDiff,
  parseOpenFile,
  processAlive,
  readLockFile,
  startIdeBridge,
  tokenMatches,
};
