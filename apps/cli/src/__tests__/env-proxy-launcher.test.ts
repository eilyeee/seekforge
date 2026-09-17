import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { envProxyRelaunch, LOOPBACK_NO_PROXY } from "../../bin/env-proxy.js";

const capable = {
  execArgv: [] as string[],
  argv: ["/usr/bin/node", "/opt/seekforge/bin/seekforge.js", "run", "-p", "fix it"],
  execPath: "/usr/bin/node",
  allowedFlags: new Set(["--use-env-proxy", "--disable-warning"]),
  hasExecve: true,
};

describe("envProxyRelaunch", () => {
  it("relaunches with the proxy flag, the same arguments, and loopback exempted", () => {
    const plan = envProxyRelaunch({ ...capable, execArgv: ["--inspect"], env: { https_proxy: "http://proxy:7897" } });
    expect(plan).toEqual({
      file: "/usr/bin/node",
      args: [
        "/usr/bin/node",
        "--use-env-proxy",
        "--disable-warning=UNDICI-EHPA",
        "--inspect",
        "/opt/seekforge/bin/seekforge.js",
        "run",
        "-p",
        "fix it",
      ],
      env: { https_proxy: "http://proxy:7897", NO_PROXY: LOOPBACK_NO_PROXY },
    });
  });

  it("keeps the user's own NO_PROXY", () => {
    for (const env of [
      { HTTP_PROXY: "http://p", NO_PROXY: "" },
      { HTTP_PROXY: "http://p", no_proxy: "corp.example" },
    ]) {
      expect(envProxyRelaunch({ ...capable, env })?.env).toEqual(env);
    }
  });

  it.each([
    ["no proxy variable", { env: { ALL_PROXY: "socks5://p", HTTP_PROXY: "  " } }],
    ["NODE_USE_ENV_PROXY already decided", { env: { HTTP_PROXY: "http://p", NODE_USE_ENV_PROXY: "0" } }],
    ["the flag already on", { env: { HTTP_PROXY: "http://p" }, execArgv: ["--use-env-proxy"] }],
    [
      "the flag turned off",
      { env: { HTTP_PROXY: "http://p", NODE_OPTIONS: "--max-old-space-size=4096 --no-use-env-proxy" } },
    ],
    ["no process.execve", { env: { HTTP_PROXY: "http://p" }, hasExecve: false }],
    ["a Node without the flag", { env: { HTTP_PROXY: "http://p" }, allowedFlags: new Set(["--disable-warning"]) }],
  ])("stays inert with %s", (_label, overrides) => {
    expect(envProxyRelaunch({ ...capable, ...overrides })).toBeNull();
  });

  it("leaves the warning alone on a Node that cannot silence it", () => {
    const plan = envProxyRelaunch({
      ...capable,
      env: { HTTP_PROXY: "http://p" },
      allowedFlags: new Set(["--use-env-proxy"]),
    });
    expect(plan?.args.slice(1, 3)).toEqual(["--use-env-proxy", "/opt/seekforge/bin/seekforge.js"]);
  });
});

const nodeCanRelaunch =
  typeof process.execve === "function" && process.allowedNodeEnvironmentFlags.has("--use-env-proxy");

describe("relaunchWithEnvProxy on this Node", () => {
  it.skipIf(!nodeCanRelaunch)("makes fetch use HTTP_PROXY, silently, while loopback stays direct", async () => {
    const seen: string[] = [];
    const target = createServer((_req, res) => res.end("direct"));
    const proxy = createServer((req, res) => {
      seen.push(req.url ?? "");
      res.end("via proxy");
    });
    // An http:// target is tunnelled with CONNECT; answer it without a real upstream.
    proxy.on("connect", (req, socket) => {
      seen.push(`CONNECT ${req.url}`);
      socket.end(
        "HTTP/1.1 200 Connection Established\r\n\r\nHTTP/1.1 200 OK\r\ncontent-length: 9\r\nconnection: close\r\n\r\nvia proxy",
      );
    });
    const listen = (server: ReturnType<typeof createServer>) =>
      new Promise<number>((done) =>
        server.listen(0, "127.0.0.1", () => done((server.address() as { port: number }).port)),
      );
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);
    const dir = mkdtempSync(join(tmpdir(), "sf-env-proxy-"));
    try {
      const launcher = pathToFileURL(resolve(import.meta.dirname, "../../bin/env-proxy.js")).href;
      const script = join(dir, "entry.mjs");
      writeFileSync(
        script,
        `import { relaunchWithEnvProxy } from ${JSON.stringify(launcher)};
relaunchWithEnvProxy();
const read = (url) => fetch(url).then((r) => r.text(), (e) => "error " + (e.cause?.message ?? e.message));
console.log(JSON.stringify({
  pid: process.pid,
  execArgv: process.execArgv,
  args: process.argv.slice(2),
  external: await read("http://seekforge.invalid:${targetPort}/"),
  loopback: await read("http://127.0.0.1:${targetPort}/"),
}));
`,
      );
      const env: Record<string, string | undefined> = { ...process.env, HTTP_PROXY: `http://127.0.0.1:${proxyPort}` };
      for (const name of [
        "http_proxy",
        "https_proxy",
        "HTTPS_PROXY",
        "NO_PROXY",
        "no_proxy",
        "NODE_USE_ENV_PROXY",
        "NODE_OPTIONS",
      ]) {
        delete env[name];
      }
      const child = spawn(process.execPath, [script, "--flag", "value with space"], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const code = await new Promise<number | null>((done) => child.on("close", done));
      expect(code).toBe(0);
      expect(stderr).toBe("");
      const report = JSON.parse(stdout) as Record<string, unknown>;
      expect(report).toMatchObject({
        pid: child.pid,
        execArgv: ["--use-env-proxy", "--disable-warning=UNDICI-EHPA"],
        args: ["--flag", "value with space"],
        external: "via proxy",
        loopback: "direct",
      });
      expect(seen).toEqual([`CONNECT seekforge.invalid:${targetPort}`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      target.close();
      proxy.close();
    }
  });
});
