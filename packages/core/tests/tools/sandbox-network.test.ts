import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PermissionRequest } from "@seekforge/shared";
import { setShellRunnerForTests } from "../../src/tools/builtins/command.js";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { closeNetworkProxiesForTests, ensureNetworkProxy } from "../../src/tools/network-proxy.js";
import {
  buildSandboxSpec,
  composeSandboxProfiles,
  NAMESPACE_BRIDGE_SCRIPT,
  proxyEnvironment,
  resolveSandboxNetwork,
  sandboxedShell,
  sandboxForRun,
  sandboxRestrictsNetwork,
  setSandboxAvailabilityCheckForTests,
  type SandboxProfile,
} from "../../src/tools/os-sandbox.js";
import { looksLikeSandboxDenial, runShellCommand } from "../../src/tools/run-command.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

afterEach(async () => {
  setSandboxAvailabilityCheckForTests(null);
  setShellRunnerForTests(null);
  await closeNetworkProxiesForTests();
});

const allowlist = { allowedDomains: ["registry.npmjs.org"] };

describe("sandboxForRun", () => {
  it("leaves plain levels alone and keeps off/absent meaning", () => {
    expect(sandboxForRun(undefined)).toBeUndefined();
    expect(sandboxForRun("off", { network: allowlist, writablePaths: ["/x"] })).toBe("off");
    expect(sandboxForRun("workspace-write")).toBe("workspace-write");
    expect(sandboxForRun("read-only", { writablePaths: ["/x"] })).toBe("read-only");
  });

  it("turns an allowlist without a level into workspace-write with that allowlist", () => {
    expect(sandboxForRun(undefined, { network: allowlist })).toEqual({
      filesystem: "workspace-write",
      network: allowlist,
      writablePaths: [],
    });
    expect(sandboxForRun("read-only", { network: allowlist })).toMatchObject({
      filesystem: "read-only",
      network: allowlist,
    });
  });

  it("never lets an allowlist widen restricted", () => {
    expect(sandboxForRun("restricted", { network: allowlist })).toMatchObject({ network: "deny" });
  });

  it("makes additional directories writable only when the level writes at all", () => {
    expect(sandboxForRun("workspace-write", { writablePaths: ["/extra"] })).toEqual({
      filesystem: "workspace-write",
      network: "inherit",
      writablePaths: ["/extra"],
    });
    expect(sandboxForRun("restricted", { writablePaths: ["/extra"], network: allowlist })).toEqual({
      filesystem: "workspace-write",
      network: "deny",
      writablePaths: ["/extra"],
    });
  });

  it("composes allowlists: deny wins, equal lists survive, different lists fall to deny", () => {
    const a: SandboxProfile = { filesystem: "workspace-write", network: { allowedDomains: ["a.dev"] } };
    const aAgain: SandboxProfile = { filesystem: "workspace-write", network: { allowedDomains: ["a.dev"] } };
    const b: SandboxProfile = { filesystem: "workspace-write", network: { allowedDomains: ["b.dev"] } };
    const inherit: SandboxProfile = { filesystem: "workspace-write", network: "inherit" };
    const deny: SandboxProfile = { filesystem: "workspace-write", network: "deny" };
    expect(composeSandboxProfiles(inherit, a).network).toEqual({ allowedDomains: ["a.dev"] });
    expect(composeSandboxProfiles(a, aAgain).network).toEqual({ allowedDomains: ["a.dev"] });
    expect(composeSandboxProfiles(a, b).network).toBe("deny");
    expect(composeSandboxProfiles(a, deny).network).toBe("deny");
    expect(sandboxRestrictsNetwork(a)).toBe(true);
    expect(sandboxRestrictsNetwork("workspace-write")).toBe(false);
    expect(sandboxRestrictsNetwork("restricted")).toBe(true);
    expect(sandboxRestrictsNetwork("off")).toBe(false);
  });
});

describe("allowlist sandbox specs", () => {
  const unresolved: SandboxProfile = { filesystem: "workspace-write", network: allowlist };
  const resolvedDarwin: SandboxProfile = {
    filesystem: "workspace-write",
    network: { ...allowlist, proxy: { port: 4567 } },
  };
  const resolvedLinux: SandboxProfile = {
    filesystem: "workspace-write",
    network: { ...allowlist, proxy: { port: 4567, socketPath: "/tmp/sf-netproxy-x/proxy.sock" } },
  };

  it("seatbelt allows only the proxy port and points clients at it", () => {
    setSandboxAvailabilityCheckForTests(() => true);
    const spec = buildSandboxSpec(resolvedDarwin, "/ws", "darwin")!;
    const profile = spec.args[1]!;
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:4567"))');
    expect(spec.args.slice(2, 3)).toEqual(["/usr/bin/env"]);
    expect(spec.args).toContain("HTTPS_PROXY=http://127.0.0.1:4567");
    expect(spec.args).toContain("https_proxy=http://127.0.0.1:4567");
    expect(spec.args).toContain("NO_PROXY=localhost,127.0.0.1,::1");
    const shell = sandboxedShell("curl https://registry.npmjs.org", resolvedDarwin, "/ws");
    expect(shell.args.slice(-3)).toEqual(["/bin/sh", "-c", "curl https://registry.npmjs.org"]);
  });

  it("an allowlist whose proxy never started has no network at all", () => {
    setSandboxAvailabilityCheckForTests(() => true);
    const darwin = buildSandboxSpec(unresolved, "/ws", "darwin")!;
    expect(darwin.args[1]).toContain("(deny network*)");
    expect(darwin.args[1]).not.toContain("network-outbound");
    expect(darwin.args).toHaveLength(2);
    const linux = buildSandboxSpec(unresolved, "/ws", "linux")!;
    expect(linux.args).toContain("--unshare-net");
    expect(linux.args).not.toContain("--setenv");
    // A darwin endpoint (no socket) cannot be bridged into a namespace either.
    const noSocket = buildSandboxSpec(resolvedDarwin, "/ws", "linux")!;
    expect(noSocket.args).toContain("--unshare-net");
    expect(noSocket.args).not.toContain(process.execPath);
  });

  it("bwrap unshares the network and bridges the proxy socket into the namespace", () => {
    setSandboxAvailabilityCheckForTests(() => true);
    const args = buildSandboxSpec(resolvedLinux, "/ws", "linux")!.args;
    expect(args).toContain("--unshare-net");
    expect(args.join(" ")).toContain("--bind /tmp/sf-netproxy-x /tmp/sf-netproxy-x");
    expect(args.join(" ")).toContain("--setenv HTTP_PROXY http://127.0.0.1:4567");
    expect(args.slice(-5)).toEqual([
      process.execPath,
      "-e",
      NAMESPACE_BRIDGE_SCRIPT,
      "/tmp/sf-netproxy-x/proxy.sock",
      "4567",
    ]);
    expect(args.indexOf("--unshare-net")).toBeLessThan(args.indexOf(process.execPath));
  });

  it("proxy environment covers upper- and lower-case client conventions", () => {
    const env = proxyEnvironment(1234);
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
      expect(env[name]).toBe("http://127.0.0.1:1234");
    }
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  it("resolves an allowlist to a running proxy once, and fails closed when it cannot start", async () => {
    const resolved = (await resolveSandboxNetwork(unresolved)) as SandboxProfile;
    expect(typeof resolved.network).toBe("object");
    const endpoint = (resolved.network as { proxy?: { port: number; socketPath?: string } }).proxy;
    expect(endpoint?.port).toBeGreaterThan(0);
    expect(endpoint?.socketPath !== undefined).toBe(process.platform === "linux");
    expect(await resolveSandboxNetwork(resolved)).toBe(resolved);
    expect(await resolveSandboxNetwork("restricted")).toBe("restricted");
    const broken = { filesystem: "workspace-write", network: { allowedDomains: {} } } as unknown as SandboxProfile;
    expect(await resolveSandboxNetwork(broken)).toMatchObject({ network: "deny" });
  });
});

describe("namespace bridge script", () => {
  it("forwards its loopback port to the unix socket, then runs the command and keeps its exit code", async () => {
    const dir = fs.mkdtempSync(path.join("/tmp", "sf-bridge-"));
    const socketPath = path.join(dir, "up.sock");
    const upstream = net.createServer((socket) => {
      socket.once("data", (chunk) => socket.end(`upstream got ${chunk.toString()}`));
    });
    await new Promise<void>((resolve) => upstream.listen(socketPath, resolve));
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const client = `const s=require("net").connect(${port},"127.0.0.1",()=>s.write("hello"));let t="";s.on("data",d=>t+=d);s.on("close",()=>{console.log(t);process.exit(3)})`;
    const child = spawn(
      process.execPath,
      ["-e", NAMESPACE_BRIDGE_SCRIPT, socketPath, String(port), process.execPath, "-e", client],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(stdout.trim()).toBe("upstream got hello");
    expect(code).toBe(3);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails recognizably when it cannot listen", async () => {
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const port = (taken.address() as net.AddressInfo).port;
    const res = spawnSync(
      process.execPath,
      ["-e", NAMESPACE_BRIDGE_SCRIPT, "/nonexistent.sock", String(port), "/bin/echo", "never"],
      {
        encoding: "utf8",
      },
    );
    await new Promise<void>((resolve) => taken.close(() => resolve()));
    expect(res.status).toBe(126);
    expect(res.stdout).toBe("");
    expect(looksLikeSandboxDenial(res.stderr)).toBe(true);
  });
});

describe("network denial heuristics", () => {
  it("counts resolver and tunnel failures only when the sandbox restricts the network", () => {
    const outputs = [
      "curl: (6) Could not resolve host: example.com",
      "Error: getaddrinfo ENOTFOUND registry.npmjs.org",
      "curl: (56) CONNECT tunnel failed, response 403",
      "ProxyError('Cannot connect to proxy.', OSError('Tunnel connection failed: 403 Forbidden'))",
    ];
    for (const output of outputs) {
      expect(looksLikeSandboxDenial(output), output).toBe(false);
      expect(looksLikeSandboxDenial(output, { networkRestricted: true }), output).toBe(true);
    }
    expect(looksLikeSandboxDenial("HTTP/1.1 403 Blocked by SeekForge sandbox")).toBe(true);
  });
});

describe("blocked connections reach the model and the escalation prompt", () => {
  it("names the hosts the proxy refused while the command ran", async () => {
    const ws = makeWorkspace();
    setShellRunnerForTests(async (_command, _cwd, _timeout, options = {}) => {
      const profile = options.sandbox as SandboxProfile;
      const endpoint = (profile.network as { proxy: { port: number } }).proxy;
      // The "command": ask the proxy for a host outside the allowlist.
      await new Promise<void>((resolve) => {
        const socket = net.connect(endpoint.port, "127.0.0.1", () =>
          socket.write("CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n"),
        );
        socket.on("data", () => socket.destroy());
        socket.on("close", () => resolve());
      });
      return { exitCode: 56, stdout: "", stderr: "curl: (56) CONNECT tunnel failed, response 403", durationMs: 1 };
    });
    const prompts: PermissionRequest[] = [];
    const ctx = makeCtx(ws, {
      sandbox: { filesystem: "workspace-write", network: { allowedDomains: ["registry.npmjs.org"] } },
      policy: { commandAllowlist: ["curl"] },
      confirm: async (req) => {
        prompts.push(req);
        return false;
      },
    });
    const res = await createDefaultDispatcher().execute(
      call("run_command", { command: "curl https://evil.example" }),
      ctx,
    );
    expect(res.ok).toBe(true);
    expect((res.data as { stderr: string }).stderr).toContain(
      "[SeekForge sandbox] blocked network access to evil.example:443 (not allowed by sandboxNetwork)",
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.escalation).toBe(true);
    expect(prompts[0]!.description).toContain("blocked network access to evil.example:443");
  });

  it("says nothing when the proxy refused nothing", async () => {
    const ws = makeWorkspace();
    await ensureNetworkProxy({ allowedDomains: ["registry.npmjs.org"] });
    setShellRunnerForTests(async () => ({ exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 1 }));
    const res = await createDefaultDispatcher().execute(
      call("run_command", { command: "echo ok" }),
      makeCtx(ws, {
        sandbox: { filesystem: "workspace-write", network: { allowedDomains: ["registry.npmjs.org"] } },
        policy: { commandAllowlist: ["echo"] },
      }),
    );
    expect((res.data as { stderr: string }).stderr).toBe("");
  });
});

// ---------------------------------------------------------------------------
// OS enforcement (skipped where the mechanism is missing; CI requires it via
// SEEKFORGE_REQUIRE_SANDBOX_TESTS in os-sandbox.test.ts)
// ---------------------------------------------------------------------------

const hasSeatbelt = process.platform === "darwin" && spawnSync("/usr/bin/which", ["sandbox-exec"]).status === 0;
const requireSandboxTests = process.env.SEEKFORGE_REQUIRE_SANDBOX_TESTS === "1";
// CI provisions bwrap with user namespaces enabled and must not skip; a
// developer machine whose bwrap cannot unshare the network skips instead.
const hasBwrap =
  process.platform === "linux" &&
  spawnSync("which", ["bwrap"]).status === 0 &&
  (requireSandboxTests || spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-net", "true"]).status === 0);
const canWriteHome = (() => {
  try {
    fs.accessSync(os.homedir(), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
})();

describe.runIf((hasSeatbelt || hasBwrap) && canWriteHome)("allowlist sandbox enforcement", () => {
  let upstream: http.Server;
  let upstreamPort: number;
  beforeAll(async () => {
    upstream = http.createServer((_req, res) => res.end("reached upstream"));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    upstreamPort = (upstream.address() as net.AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  /** A client that sends one absolute-form request through $HTTP_PROXY. */
  const viaProxy = (host: string) =>
    `const u=new URL(process.env.HTTP_PROXY);require("http").get({host:u.hostname,port:u.port,path:"http://${host}:"+process.argv[1]+"/",headers:{host:"${host}"}},r=>{let b="";r.on("data",d=>b+=d);r.on("end",()=>{console.log(r.statusCode+" "+b.trim());process.exit(0)})}).on("error",e=>{console.log("ERR "+e.code);process.exit(1)})`;
  const direct = `require("net").connect(Number(process.argv[1]),"127.0.0.1").on("connect",()=>{console.log("CONNECTED");process.exit(0)}).on("error",e=>{console.log("ERR "+e.code);process.exit(1)})`;

  it("lets an allowed host through the proxy and nothing past it", async () => {
    const ws = makeWorkspace();
    const sandbox = { filesystem: "workspace-write" as const, network: { allowedDomains: ["localhost"] } };
    const node = JSON.stringify(process.execPath);
    const allowed = await runShellCommand(`${node} -e '${viaProxy("localhost")}' ${upstreamPort}`, ws, 20_000, {
      sandbox,
    });
    expect(allowed.stdout.trim()).toBe("200 reached upstream");

    const refused = await runShellCommand(`${node} -e '${viaProxy("blocked.test")}' ${upstreamPort}`, ws, 20_000, {
      sandbox,
    });
    expect(refused.stdout).toContain("403");
    expect(refused.stdout).toContain("blocked.test is blocked");

    const bypass = await runShellCommand(`${node} -e '${direct}' ${upstreamPort}`, ws, 20_000, { sandbox });
    expect(bypass.stdout).not.toContain("CONNECTED");
    expect(bypass.exitCode).not.toBe(0);
  });

  it("keeps the filesystem rules of the level underneath", async () => {
    const ws = makeWorkspace();
    const outside = fs.mkdtempSync(path.join(os.homedir(), ".seekforge-sbx-net-"));
    try {
      const shell = sandboxedShell(
        `echo nope > "${path.join(outside, "x")}"`,
        (await resolveSandboxNetwork({ filesystem: "workspace-write", network: { allowedDomains: ["localhost"] } }))!,
        ws,
      );
      expect(spawnSync(shell.bin, shell.args, { cwd: ws }).status).not.toBe(0);
      expect(fs.existsSync(path.join(outside, "x"))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("makes additional directories writable", async () => {
    const ws = makeWorkspace();
    const extra = fs.mkdtempSync(path.join(os.homedir(), ".seekforge-sbx-extra-"));
    try {
      const sandbox = sandboxForRun("workspace-write", { writablePaths: [extra] });
      const res = await runShellCommand(`echo ok > "${path.join(extra, "x")}"`, ws, 10_000, { sandbox });
      expect(res.exitCode).toBe(0);
      expect(fs.readFileSync(path.join(extra, "x"), "utf8").trim()).toBe("ok");
      const readOnly = await runShellCommand(`echo no > "${path.join(extra, "y")}"`, ws, 10_000, {
        sandbox: sandboxForRun("read-only", { writablePaths: [extra] }),
      });
      expect(readOnly.exitCode).not.toBe(0);
    } finally {
      fs.rmSync(extra, { recursive: true, force: true });
    }
  });
});
