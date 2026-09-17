const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  LOCK_VERSION,
  MALFORMED_LOCK_GRACE_MS,
  cleanupStaleLocks,
  hostAllowed,
  lockDirectory,
  processAlive,
  readLockFile,
  startIdeBridge,
  tokenMatches,
} = require("../src/ide-bridge.cjs");

const posix = process.platform !== "win32";

/** A private HOME per test: nothing here may read or write the developer's own ~/.seekforge. */
function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-ide-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function startFor(t, overrides = {}) {
  const homeDir = tempHome(t);
  const calls = { openDiff: [], openFile: [] };
  const folders = ["/work/a"];
  const bridge = await startIdeBridge({
    homeDir,
    ideName: "Visual Studio Code",
    workspaceFolders: () => folders,
    handlers: {
      context: () => ({ openFiles: ["/work/a/x.ts"], diagnostics: [] }),
      openDiff: async (input) => calls.openDiff.push(input),
      openFile: async (input) => calls.openFile.push(input),
    },
    ...overrides,
  });
  t.after(() => bridge.close());
  return { bridge, homeDir, calls, folders };
}

function request(port, { method = "GET", pathname = "/v1/context", headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: pathname,
        headers: {
          host: host ?? `127.0.0.1:${port}`,
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }),
        );
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const auth = (token) => ({ authorization: `Bearer ${token}` });

test("writes an owner-only lock file that describes the bridge exactly", async (t) => {
  const { bridge, homeDir } = await startFor(t);
  const dir = lockDirectory(homeDir);
  assert.equal(bridge.lockPath, path.join(dir, `${bridge.port}.json`));
  const lock = JSON.parse(fs.readFileSync(bridge.lockPath, "utf8"));
  assert.deepEqual(lock, {
    version: LOCK_VERSION,
    port: bridge.port,
    token: bridge.token,
    pid: process.pid,
    ideName: "Visual Studio Code",
    workspaceFolders: ["/work/a"],
  });
  assert.match(bridge.token, /^[0-9a-f]{64}$/);
  if (posix) {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(bridge.lockPath).mode & 0o777, 0o600);
  }
});

test("tightens an existing lock directory and refuses a symlinked one", { skip: !posix }, async (t) => {
  const homeDir = tempHome(t);
  const dir = lockDirectory(homeDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  const bridge = await startIdeBridge({ homeDir, ideName: "x", handlers: {} });
  await bridge.close();
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);

  const other = tempHome(t);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-ide-target-"));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  fs.mkdirSync(path.join(other, ".seekforge"), { recursive: true });
  fs.symlinkSync(target, lockDirectory(other));
  await assert.rejects(startIdeBridge({ homeDir: other, ideName: "x", handlers: {} }), /is not a directory/);
});

test("every request needs the bearer token", async (t) => {
  const { bridge } = await startFor(t);
  assert.equal((await request(bridge.port)).status, 401);
  assert.equal((await request(bridge.port, { headers: auth("0".repeat(64)) })).status, 401);
  assert.equal((await request(bridge.port, { headers: { authorization: bridge.token } })).status, 401);
  assert.equal((await request(bridge.port, { headers: { authorization: `Basic ${bridge.token}` } })).status, 401);
  const okResponse = await request(bridge.port, { headers: auth(bridge.token) });
  assert.equal(okResponse.status, 200);
  assert.deepEqual(okResponse.body, { openFiles: ["/work/a/x.ts"], diagnostics: [] });
  assert.equal(okResponse.headers["access-control-allow-origin"], undefined);
  assert.equal(okResponse.headers["cache-control"], "no-store");
});

test("rejects browser origins and non-loopback Host headers before checking anything else", async (t) => {
  const { bridge } = await startFor(t);
  const headers = auth(bridge.token);
  const origin = await request(bridge.port, { headers: { ...headers, origin: "http://127.0.0.1:3000" } });
  assert.equal(origin.status, 403);
  for (const host of [
    `evil.example:${bridge.port}`,
    `127.0.0.1:${bridge.port + 1}`,
    "127.0.0.1",
    `127.0.0.1.evil:${bridge.port}`,
  ]) {
    assert.equal((await request(bridge.port, { headers, host })).status, 403, host);
  }
  for (const host of [`localhost:${bridge.port}`, `LOCALHOST:${bridge.port}`, `127.0.0.1:${bridge.port}`]) {
    assert.equal((await request(bridge.port, { headers, host })).status, 200, host);
  }
  // Without a token, a rebinding page learns nothing beyond "forbidden".
  assert.equal((await request(bridge.port, { host: `evil.example:${bridge.port}` })).status, 403);
});

test("host and token helpers", () => {
  assert.equal(hostAllowed("[::1]:80", 80), true);
  assert.equal(hostAllowed("[::2]:80", 80), false);
  assert.equal(hostAllowed(undefined, 80), false);
  assert.equal(hostAllowed("localhost:080", 80), true);
  assert.equal(tokenMatches("Bearer abc", "abc"), true);
  assert.equal(tokenMatches("Bearer abcd", "abc"), false);
  assert.equal(tokenMatches(undefined, "abc"), false);
});

test("routes: unknown paths are 404 and wrong methods 405", async (t) => {
  const { bridge } = await startFor(t);
  const headers = auth(bridge.token);
  assert.equal((await request(bridge.port, { headers, pathname: "/v1/nope" })).status, 404);
  assert.equal((await request(bridge.port, { headers, pathname: "/v1/context/../context" })).status, 404);
  const wrong = await request(bridge.port, { headers, method: "POST", pathname: "/v1/context", body: {} });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.allow, "GET");
  assert.equal((await request(bridge.port, { headers, pathname: "/v1/openDiff" })).status, 405);
  // A query string does not change the route.
  assert.equal((await request(bridge.port, { headers, pathname: "/v1/context?x=1" })).status, 200);
});

test("openDiff validates its body and hands the editor exactly what it needs", async (t) => {
  const { bridge, calls } = await startFor(t);
  const headers = auth(bridge.token);
  const absolute = path.resolve("/work/a/src/app.ts");
  const post = (body) => request(bridge.port, { headers, method: "POST", pathname: "/v1/openDiff", body });

  const accepted = await post({ path: absolute, original: "a", proposed: "b", title: "Proposed", extra: 1 });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body, { ok: true });
  assert.deepEqual(calls.openDiff, [{ path: absolute, original: "a", proposed: "b", title: "Proposed" }]);

  for (const body of [
    { path: "src/app.ts", original: "a", proposed: "b" },
    { path: "", original: "a", proposed: "b" },
    { path: `${absolute}\0x`, original: "a", proposed: "b" },
    { path: absolute, original: 1, proposed: "b" },
    { path: absolute, original: "a" },
    { path: absolute, original: "a", proposed: "b", title: "x".repeat(201) },
    { path: absolute, original: "a", proposed: "b", title: 5 },
  ]) {
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error, "bad_request");
  }
  assert.equal((await post("not json")).status, 400);
  assert.equal((await post("[1,2]")).status, 400);
  assert.equal((await post("null")).status, 400);
  assert.equal(calls.openDiff.length, 1);
});

test("openFile requires an absolute path to an existing file and a positive line", async (t) => {
  const { bridge, calls, homeDir } = await startFor(t);
  const headers = auth(bridge.token);
  const target = path.join(homeDir, "file.ts");
  fs.writeFileSync(target, "one\ntwo\n");
  const post = (body) => request(bridge.port, { headers, method: "POST", pathname: "/v1/openFile", body });

  assert.equal((await post({ path: target, line: 2 })).status, 200);
  assert.equal((await post({ path: target })).status, 200);
  assert.deepEqual(calls.openFile, [{ path: target, line: 2 }, { path: target }]);

  assert.equal((await post({ path: "file.ts" })).status, 400);
  assert.equal((await post({ path: target, line: 0 })).status, 400);
  assert.equal((await post({ path: target, line: 1.5 })).status, 400);
  assert.equal((await post({ path: target, line: "2" })).status, 400);
  assert.equal((await post({ path: path.join(homeDir, "missing.ts") })).status, 404);
  assert.equal((await post({ path: homeDir })).status, 404);
  assert.equal(calls.openFile.length, 2);
});

test("an oversized body is refused whether or not it declares its length", async (t) => {
  const { bridge, calls } = await startFor(t, { maxBodyBytes: 64 });
  const headers = auth(bridge.token);
  const big = { path: path.resolve("/x"), original: "a".repeat(100), proposed: "b" };
  const declared = await request(bridge.port, { headers, method: "POST", pathname: "/v1/openDiff", body: big });
  assert.equal(declared.status, 413);
  assert.equal(declared.headers.connection, "close");

  const chunked = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: bridge.port,
        method: "POST",
        path: "/v1/openDiff",
        headers: { ...headers, "transfer-encoding": "chunked" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", (error) => (error.code === "ECONNRESET" || error.code === "EPIPE" ? resolve(413) : reject(error)));
    req.write("x".repeat(40));
    req.write("y".repeat(40));
    req.end();
  });
  assert.equal(chunked, 413);
  assert.equal(calls.openDiff.length, 0);
  // The server keeps serving after refusing.
  assert.equal((await request(bridge.port, { headers })).status, 200);
});

test("a handler failure is a 500 that does not leak its message", async (t) => {
  const { bridge } = await startFor(t, {
    handlers: {
      context: () => {
        throw new Error("secret internals");
      },
      openDiff: async () => {},
      openFile: async () => {},
    },
  });
  const response = await request(bridge.port, { headers: auth(bridge.token) });
  assert.equal(response.status, 500);
  assert.equal(response.body.error, "internal");
  assert.doesNotMatch(JSON.stringify(response.body), /secret internals/);
});

test("close removes its own lock and stops listening", async (t) => {
  const { bridge } = await startFor(t);
  await bridge.close();
  await bridge.close();
  assert.equal(fs.existsSync(bridge.lockPath), false);
  await assert.rejects(request(bridge.port, { headers: auth(bridge.token) }));
});

test("close leaves a lock that another window has taken over", async (t) => {
  const { bridge } = await startFor(t);
  const replacement = { ...readLockFile(bridge.lockPath), token: "f".repeat(64), pid: process.pid };
  fs.writeFileSync(bridge.lockPath, JSON.stringify(replacement));
  await bridge.close();
  assert.equal(readLockFile(bridge.lockPath).token, "f".repeat(64));
});

test("refresh rewrites the folders, and the heartbeat restores a deleted lock", async (t) => {
  const { bridge, folders } = await startFor(t, { heartbeatMs: 20 });
  folders.push("/work/b");
  bridge.refresh();
  assert.deepEqual(readLockFile(bridge.lockPath).workspaceFolders, ["/work/a", "/work/b"]);
  fs.unlinkSync(bridge.lockPath);
  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(bridge.lockPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(readLockFile(bridge.lockPath).token, bridge.token);
});

test("stale lock cleanup removes only dead owners and old unreadable files", (t) => {
  const dir = lockDirectory(tempHome(t));
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, content) => fs.writeFileSync(path.join(dir, name), content);
  write("1111.json", JSON.stringify({ version: 1, port: 1111, token: "a", pid: 999_999_991 }));
  write("2222.json", JSON.stringify({ version: 1, port: 2222, token: "b", pid: process.pid }));
  write("3333.json", "{ half a lock");
  write("4444.json", "null");
  write("notes.txt", "keep me");
  write("5555.json.tmp", "keep me");
  const old = (Date.now() - MALFORMED_LOCK_GRACE_MS - 5_000) / 1000;
  fs.utimesSync(path.join(dir, "4444.json"), old, old);
  if (posix) fs.symlinkSync(path.join(dir, "notes.txt"), path.join(dir, "6666.json"));

  const alive = (pid) => pid === process.pid;
  const removed = cleanupStaleLocks(dir, { isAlive: alive }).sort();
  assert.deepEqual(removed, ["1111.json", "4444.json"]);
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(
    left,
    ["2222.json", "3333.json", "5555.json.tmp", "notes.txt", ...(posix ? ["6666.json"] : [])].sort(),
  );
  assert.deepEqual(cleanupStaleLocks(path.join(dir, "missing")), []);
});

test("a starting bridge clears a dead window's lock", async (t) => {
  const homeDir = tempHome(t);
  const dir = lockDirectory(homeDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "1.json"), JSON.stringify({ pid: 424242 }));
  const bridge = await startIdeBridge({ homeDir, ideName: "x", handlers: {}, isAlive: () => false });
  t.after(() => bridge.close());
  assert.equal(fs.existsSync(path.join(dir, "1.json")), false);
  assert.equal(fs.existsSync(bridge.lockPath), true);
});

test("process liveness treats a permission error as alive", () => {
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(0), false);
  assert.equal(processAlive(-5), false);
  assert.equal(processAlive(Number.NaN), false);
  assert.equal(processAlive(999_999_991), false);
});
