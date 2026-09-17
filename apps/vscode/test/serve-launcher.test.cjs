const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  ServeProcess,
  maskServeToken,
  parseServeUrl,
  serveInvocation,
  windowsSafeArgument,
} = require("../src/serve-launcher.cjs");

const TOKEN = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg";

test("reads the address from either locale's startup line", () => {
  assert.deepEqual(parseServeUrl(`SeekForge server: http://127.0.0.1:7373/?token=${TOKEN}\n`), {
    port: 7373,
    token: TOKEN,
  });
  assert.deepEqual(parseServeUrl(`SeekForge 服务器：http://127.0.0.1:40123/?token=${TOKEN}`), {
    port: 40123,
    token: TOKEN,
  });
  assert.equal(parseServeUrl("Serving 1 workspace(s) on 127.0.0.1 only:"), undefined);
  assert.equal(parseServeUrl(`http://127.0.0.1:0/?token=${TOKEN}`), undefined);
  assert.equal(parseServeUrl(`http://127.0.0.1:99999/?token=${TOKEN}`), undefined);
  assert.equal(parseServeUrl("http://127.0.0.1:7373/?token=short"), undefined);
});

test("masks the token wherever the URL appears", () => {
  const text = `a http://127.0.0.1:1/?token=${TOKEN} b http://127.0.0.1:2/?token=${TOKEN}`;
  const masked = maskServeToken(text);
  assert.doesNotMatch(masked, new RegExp(TOKEN));
  assert.equal(masked, "a http://127.0.0.1:1/?token=<saved to VS Code> b http://127.0.0.1:2/?token=<saved to VS Code>");
});

test("passes folders as separate arguments, never through a shell", () => {
  const folders = ["/repo/it's; rm -rf ~", "/repo/$(id)"];
  assert.deepEqual(serveInvocation({ command: "seekforge", folders, port: 7373, platform: "darwin" }), {
    command: "seekforge",
    args: ["serve", ...folders, "--port", "7373"],
    shell: false,
    skipped: [],
  });
});

test("on Windows, only arguments cmd.exe cannot reinterpret are passed", () => {
  const result = serveInvocation({
    command: "C:\\Tools\\seekforge.cmd",
    folders: ["C:\\repo\\app (1)", "C:\\repo\\100%&calc", 'C:\\repo\\"quoted"'],
    port: 7373,
    platform: "win32",
  });
  assert.equal(result.shell, true);
  assert.equal(result.command, '"C:\\Tools\\seekforge.cmd"');
  assert.deepEqual(result.args, ['"serve"', '"C:\\repo\\app (1)"', '"--port"', '"7373"']);
  assert.deepEqual(result.skipped, ["C:\\repo\\100%&calc", 'C:\\repo\\"quoted"']);
  assert.throws(
    () => serveInvocation({ command: "seek&forge", folders: [], port: 1, platform: "win32" }),
    /Refusing to run/,
  );
  assert.equal(windowsSafeArgument("C:\\a b\\c.d-e_f"), true);
  assert.equal(windowsSafeArgument("a^b"), false);
  assert.equal(windowsSafeArgument("!x!"), false);
});

function fakeSpawn() {
  const spawned = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.signals = [];
    child.kill = (signal) => {
      child.signals.push(signal);
      if (signal === "SIGTERM" && !child.ignoreTerm) {
        queueMicrotask(() => {
          child.emit("exit", null, signal);
          child.emit("close", null, signal);
        });
      }
      return true;
    };
    spawned.push({ command, args, options, child });
    return child;
  };
  return { spawn, spawned };
}

test("becomes ready on the address line even when it arrives split, and masks it in output", async () => {
  const { spawn, spawned } = fakeSpawn();
  const serve = new ServeProcess({ command: "seekforge", args: ["serve"], cwd: "/repo", spawn });
  const lines = [];
  serve.onOutput((text) => lines.push(text));
  const { child, options } = spawned[0];
  assert.equal(options.shell, false);
  assert.equal(options.cwd, "/repo");
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
  child.stdout.emit("data", Buffer.from(`SeekForge server: http://127.0.0.1:7373/?token=${TOKEN.slice(0, 10)}`));
  child.stdout.emit("data", Buffer.from(`${TOKEN.slice(10)}\nServing 1 workspace(s)\n`));
  assert.deepEqual(await serve.ready, { port: 7373, token: TOKEN });
  assert.equal(
    lines.join(""),
    "SeekForge server: http://127.0.0.1:7373/?token=<saved to VS Code>\nServing 1 workspace(s)\n",
  );
  await serve.stop();
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(serve.exited, true);
});

test("an exit before the address line rejects ready and flushes the last partial line", async () => {
  const { spawn, spawned } = fakeSpawn();
  const serve = new ServeProcess({ command: "seekforge", args: ["serve"], spawn });
  const lines = [];
  const exits = [];
  serve.onOutput((text) => lines.push(text));
  serve.onExit((code) => exits.push(code));
  const { child } = spawned[0];
  child.stderr.emit("data", "error: config is broken");
  child.emit("exit", 1, null);
  child.emit("close", 1, null);
  await assert.rejects(serve.ready, /exited \(1\) before it was ready/);
  assert.deepEqual(lines, ["error: config is broken"]);
  assert.deepEqual(exits, [1]);
  assert.equal(serve.exitCode, 1);
  await serve.stop();
});

test("a missing executable rejects ready with the spawn error", async () => {
  const { spawn, spawned } = fakeSpawn();
  const serve = new ServeProcess({ command: "nope", args: [], spawn });
  spawned[0].child.emit("error", Object.assign(new Error("spawn nope ENOENT"), { code: "ENOENT" }));
  await assert.rejects(serve.ready, (error) => error.code === "ENOENT");
});

test("a server that never prints its address times out", async () => {
  const { spawn } = fakeSpawn();
  const serve = new ServeProcess({ command: "seekforge", args: [], spawn, readyTimeoutMs: 10 });
  await assert.rejects(serve.ready, /did not report its address/);
});

test("stop escalates to SIGKILL when SIGTERM is ignored", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { spawn, spawned } = fakeSpawn();
  const serve = new ServeProcess({ command: "seekforge", args: [], spawn, readyTimeoutMs: 100_000 });
  const { child } = spawned[0];
  child.ignoreTerm = true;
  const stopping = serve.stop();
  assert.deepEqual(child.signals, ["SIGTERM"]);
  t.mock.timers.tick(5_000);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  child.emit("exit", null, "SIGKILL");
  child.emit("close", null, "SIGKILL");
  await stopping;
  await assert.rejects(serve.ready);
});

test("drives a real child process end to end", async () => {
  const script = `console.log("SeekForge server: http://127.0.0.1:7373/?token=${TOKEN}"); setInterval(() => {}, 1000);`;
  const serve = new ServeProcess({ command: process.execPath, args: ["-e", script] });
  const output = [];
  serve.onOutput((text) => output.push(text));
  assert.deepEqual(await serve.ready, { port: 7373, token: TOKEN });
  await serve.stop();
  assert.equal(serve.exited, true);
  assert.doesNotMatch(output.join(""), new RegExp(TOKEN));
});
