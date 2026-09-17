import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  closeNetworkProxiesForTests,
  ensureNetworkProxy,
  networkProxyAt,
  parseAuthority,
  PROXY_BLOCK_REASON,
  startNetworkProxy,
  upstreamProxiesFromEnv,
  type HostResolver,
  type NetworkProxy,
} from "../../src/tools/network-proxy.js";

let upstream: http.Server;
let upstreamPort: number;
let echo: net.Server;
let echoPort: number;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "x-upstream": "yes" });
    res.end(
      `upstream saw ${req.method} ${req.url} host=${req.headers.host} proxy-auth=${req.headers["proxy-authorization"] ?? "-"}`,
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as net.AddressInfo).port;
  echo = net.createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  echoPort = (echo.address() as net.AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await new Promise<void>((resolve) => echo.close(() => resolve()));
});

const proxies: NetworkProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  await closeNetworkProxiesForTests();
});

async function proxyFor(allowedDomains: string[], deniedDomains?: string[]): Promise<NetworkProxy> {
  const proxy = await startNetworkProxy({ allowedDomains, ...(deniedDomains ? { deniedDomains } : {}) });
  proxies.push(proxy);
  return proxy;
}

/** Raw CONNECT; resolves with the status line and the connected socket. */
function connectThrough(
  port: number,
  authority: string,
): Promise<{ status: string; head: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("latin1");
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      socket.pause();
      resolve({ status: buffer.slice(0, buffer.indexOf("\r\n")), head: buffer, socket });
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
}

/** Everything the proxy sent: what connectThrough already read plus the rest. */
function readAll(connected: { head: string; socket: net.Socket }): Promise<string> {
  return new Promise((resolve) => {
    let text = connected.head;
    connected.socket.on("data", (chunk) => (text += chunk.toString("utf8")));
    connected.socket.on("close", () => resolve(text));
    connected.socket.resume();
  });
}

function getThrough(
  port: number,
  target: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; statusMessage: string; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const req = http.request(
      { host: "127.0.0.1", port, method: "GET", path: target, headers: { host: url.host, ...headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, statusMessage: res.statusMessage ?? "", body, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("parseAuthority", () => {
  it("splits host and port, including bracketed IPv6", () => {
    expect(parseAuthority("example.com:443", 80)).toEqual({ host: "example.com", port: 443 });
    expect(parseAuthority("example.com", 443)).toEqual({ host: "example.com", port: 443 });
    expect(parseAuthority("[::1]:8443", 443)).toEqual({ host: "::1", port: 8443 });
    expect(parseAuthority("example.com:0", 443)).toBeNull();
    expect(parseAuthority("example.com:99999", 443)).toBeNull();
    expect(parseAuthority("user@example.com:443", 443)).toEqual({ host: "user@example.com", port: 443 });
    expect(parseAuthority("a:b:c", 443)).toBeNull();
  });
});

describe("network proxy: CONNECT", () => {
  it("tunnels to an allowed host and relays bytes both ways", async () => {
    const proxy = await proxyFor(["localhost"]);
    const { status, socket } = await connectThrough(proxy.port, `localhost:${echoPort}`);
    expect(status).toBe("HTTP/1.1 200 Connection Established");
    socket.resume();
    const reply = new Promise<string>((resolve) => socket.once("data", (chunk) => resolve(chunk.toString())));
    socket.write("ping");
    expect(await reply).toBe("ping");
    socket.destroy();
    expect(proxy.blockedCount()).toBe(0);
  });

  it("refuses a host outside the allowlist with a recognizable 403 and logs it", async () => {
    const proxy = await proxyFor(["*.example.com"]);
    const mark = proxy.blockedCount();
    const refused = await connectThrough(proxy.port, `docs.example.com.evil.net:${echoPort}`);
    expect(refused.status).toBe(`HTTP/1.1 403 ${PROXY_BLOCK_REASON}`);
    expect(refused.head).toContain("X-SeekForge-Sandbox: blocked");
    const body = await readAll(refused);
    expect(body).toContain("docs.example.com.evil.net");
    expect(body).toContain("not in sandboxNetwork.allowedDomains");
    expect(proxy.blockedSince(mark)).toEqual([
      expect.objectContaining({ host: "docs.example.com.evil.net", port: echoPort, reason: "not_allowed" }),
    ]);
  });

  it("lets deniedDomains override an allow pattern", async () => {
    const proxy = await proxyFor(["*.example.com"], ["secret.example.com"]);
    const refused = await connectThrough(proxy.port, "secret.example.com:443");
    expect(refused.status).toContain("403");
    expect(await readAll(refused)).toContain("sandboxNetwork.deniedDomains");
    expect(proxy.blockedSince(0).map((entry) => entry.reason)).toEqual(["denied"]);
  });

  it("answers a malformed CONNECT target with 400 and an unreachable allowed host with 502", async () => {
    const proxy = await proxyFor(["localhost"]);
    const malformed = await connectThrough(proxy.port, "localhost:notaport");
    expect(malformed.status).toContain("400");
    malformed.socket.destroy();
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const deadPort = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const unreachable = await connectThrough(proxy.port, `localhost:${deadPort}`);
    expect(unreachable.status).toContain("502");
    unreachable.socket.destroy();
    expect(proxy.blockedCount()).toBe(0);
  });
});

describe("network proxy: plain HTTP", () => {
  it("forwards an absolute-form request to an allowed host without proxy headers", async () => {
    const proxy = await proxyFor(["localhost"]);
    const res = await getThrough(proxy.port, `http://localhost:${upstreamPort}/path?q=1`, {
      "proxy-authorization": "Basic c2VjcmV0",
    });
    expect(res.status).toBe(200);
    expect(res.headers["x-upstream"]).toBe("yes");
    expect(res.body).toBe(`upstream saw GET /path?q=1 host=localhost:${upstreamPort} proxy-auth=-`);
  });

  it("refuses a disallowed host with the block reason in the status line and body", async () => {
    const proxy = await proxyFor(["localhost"]);
    const res = await getThrough(proxy.port, "http://127.0.0.1:9/");
    expect(res.status).toBe(403);
    expect(res.statusMessage).toBe(PROXY_BLOCK_REASON);
    expect(res.headers["x-seekforge-sandbox"]).toBe("blocked");
    expect(res.body).toContain("network access to 127.0.0.1 is blocked");
    expect(proxy.blockedSince(0)).toHaveLength(1);
  });

  it("rejects origin-form and https absolute-form requests", async () => {
    const proxy = await proxyFor(["localhost"]);
    const origin = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port: proxy.port, path: "/" }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on("error", reject);
    });
    expect(origin).toBe(400);
    const https = await getThrough(proxy.port, `https://localhost:${upstreamPort}/`);
    expect(https.status).toBe(400);
    expect(proxy.blockedCount()).toBe(0);
  });
});

describe("upstream proxies", () => {
  it("reads the process's own proxy variables, http:// only", () => {
    expect(
      upstreamProxiesFromEnv({
        http_proxy: "http://user:p%40ss@proxy.corp:3128",
        HTTP_PROXY: "http://ignored:1",
        all_proxy: "socks5://127.0.0.1:1080",
        NO_PROXY: "internal.corp, .svc:8080 *.local",
      }),
    ).toEqual({
      http: new URL("http://user:p%40ss@proxy.corp:3128"),
      noProxy: ["internal.corp", ".svc", "*.local"],
    });
    expect(upstreamProxiesFromEnv({ https_proxy: "not a url", HTTPS_PROXY: "http://x:1" })).toEqual({ noProxy: [] });
    expect(upstreamProxiesFromEnv({})).toEqual({ noProxy: [] });
  });

  /** A stand-in corporate proxy: records what it was asked, then does the job. */
  async function fakeUpstream(): Promise<{ port: number; seen: string[]; close: () => Promise<void> }> {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url} auth=${req.headers["proxy-authorization"] ?? "-"}`);
      res.end("via upstream");
    });
    server.on("connect", (req, socket: net.Socket) => {
      seen.push(`CONNECT ${req.url} auth=${req.headers["proxy-authorization"] ?? "-"}`);
      if (req.url?.startsWith("refuse.test")) {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const inner = net.connect(echoPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 OK\r\n\r\n");
        inner.pipe(socket);
        socket.pipe(inner);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      port: (server.address() as net.AddressInfo).port,
      seen,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }

  it("chains allowed traffic through the upstream, with its credentials, and still refuses the rest", async () => {
    const corp = await fakeUpstream();
    const proxy = await startNetworkProxy(
      { allowedDomains: ["*.corp.test", "refuse.test"] },
      {
        upstream: {
          http: new URL(`http://me:s%3Acret@127.0.0.1:${corp.port}`),
          https: new URL(`http://me:s%3Acret@127.0.0.1:${corp.port}`),
          noProxy: [],
        },
      },
    );
    proxies.push(proxy);
    const auth = `Basic ${Buffer.from("me:s:cret").toString("base64")}`;

    const tunnelled = await connectThrough(proxy.port, "api.corp.test:443");
    expect(tunnelled.status).toBe("HTTP/1.1 200 Connection Established");
    tunnelled.socket.resume();
    const reply = new Promise<string>((resolve) => tunnelled.socket.once("data", (chunk) => resolve(chunk.toString())));
    tunnelled.socket.write("through two proxies");
    expect(await reply).toBe("through two proxies");
    tunnelled.socket.destroy();

    const refusedUpstream = await connectThrough(proxy.port, "refuse.test:443");
    expect(refusedUpstream.status).toContain("502");
    refusedUpstream.socket.destroy();

    const plain = await getThrough(proxy.port, "http://www.corp.test/x?y=1");
    expect(plain.body).toBe("via upstream");

    const blocked = await connectThrough(proxy.port, "evil.test:443");
    expect(blocked.status).toContain("403");
    blocked.socket.destroy();

    expect(corp.seen).toEqual([
      `CONNECT api.corp.test:443 auth=${auth}`,
      `CONNECT refuse.test:443 auth=${auth}`,
      `GET http://www.corp.test/x?y=1 auth=${auth}`,
    ]);
    await corp.close();
  });

  it("goes direct for loopback and NO_PROXY hosts", async () => {
    const corp = await fakeUpstream();
    const proxy = await startNetworkProxy(
      { allowedDomains: ["localhost"] },
      {
        upstream: {
          http: new URL(`http://127.0.0.1:${corp.port}`),
          https: new URL(`http://127.0.0.1:${corp.port}`),
          noProxy: ["localhost"],
        },
      },
    );
    proxies.push(proxy);
    const res = await getThrough(proxy.port, `http://localhost:${upstreamPort}/direct`);
    expect(res.body).toContain("upstream saw GET /direct");
    expect(corp.seen).toEqual([]);
    await corp.close();
  });
});

describe("network proxy name resolution", () => {
  /** A resolver that answers from a table and counts what it was asked. */
  function fakeResolver(table: Record<string, string[]>): { resolve: HostResolver; asked: string[] } {
    const asked: string[] = [];
    return {
      asked,
      resolve: async (host) => {
        asked.push(host);
        const addresses = table[host];
        if (!addresses) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
        return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
      },
    };
  }

  it("refuses a wildcard-only name that resolves to this machine or its link", async () => {
    const dns = fakeResolver({
      "api.rebind.test": ["203.0.113.7", "127.0.0.1"],
      "meta.rebind.test": ["169.254.169.254"],
      "mapped.rebind.test": ["::ffff:127.0.0.1"],
    });
    const proxy = await startNetworkProxy({ allowedDomains: ["*.rebind.test"] }, { resolve: dns.resolve });
    proxies.push(proxy);
    for (const host of ["api.rebind.test", "meta.rebind.test", "mapped.rebind.test"]) {
      const refused = await connectThrough(proxy.port, `${host}:${echoPort}`);
      expect(refused.status, host).toBe(`HTTP/1.1 403 ${PROXY_BLOCK_REASON}`);
      expect(await readAll(refused)).toContain("loopback or link-local");
    }
    const plain = await getThrough(proxy.port, `http://api.rebind.test:${upstreamPort}/`);
    expect(plain.status).toBe(403);
    expect(proxy.blockedSince(0).map((entry) => entry.reason)).toEqual([
      "local_address",
      "local_address",
      "local_address",
      "local_address",
    ]);
  });

  it("trusts an exactly listed name wherever it resolves, and connects only to what it resolved", async () => {
    const dns = fakeResolver({ "dev.rebind.test": ["127.0.0.1"] });
    const proxy = await startNetworkProxy({ allowedDomains: ["dev.rebind.test"] }, { resolve: dns.resolve });
    proxies.push(proxy);
    const tunnelled = await connectThrough(proxy.port, `dev.rebind.test:${echoPort}`);
    expect(tunnelled.status).toBe("HTTP/1.1 200 Connection Established");
    tunnelled.socket.resume();
    const reply = new Promise<string>((resolve) => tunnelled.socket.once("data", (chunk) => resolve(chunk.toString())));
    tunnelled.socket.write("pinned");
    expect(await reply).toBe("pinned");
    tunnelled.socket.destroy();
    const plain = await getThrough(proxy.port, `http://dev.rebind.test:${upstreamPort}/p`);
    expect(plain.body).toBe(`upstream saw GET /p host=dev.rebind.test:${upstreamPort} proxy-auth=-`);
    expect(dns.asked).toEqual(["dev.rebind.test", "dev.rebind.test"]);
  });

  it("answers 502 for a name that does not resolve, and never resolves IP literals", async () => {
    const dns = fakeResolver({});
    const proxy = await startNetworkProxy({ allowedDomains: ["*.gone.test", "127.0.0.1"] }, { resolve: dns.resolve });
    proxies.push(proxy);
    const missing = await connectThrough(proxy.port, "x.gone.test:443");
    expect(missing.status).toContain("502");
    missing.socket.destroy();
    expect((await getThrough(proxy.port, "http://y.gone.test/")).status).toBe(502);
    const literal = await getThrough(proxy.port, `http://127.0.0.1:${upstreamPort}/lit`);
    expect(literal.body).toContain("upstream saw GET /lit");
    expect(dns.asked).toEqual(["x.gone.test", "y.gone.test"]);
    expect(proxy.blockedCount()).toBe(0);
  });
});

describe("network proxy edges", () => {
  async function deadPort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  it("serves the same policy on a private unix socket and removes it on close", async () => {
    const proxy = await startNetworkProxy({ allowedDomains: ["localhost"] }, { unixSocket: true });
    expect(proxy.socketPath).toBeDefined();
    const socketPath = proxy.socketPath!;
    expect(fs.statSync(socketPath).isSocket()).toBe(true);
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(
          {
            socketPath,
            path: `http://localhost:${upstreamPort}/over-unix`,
            headers: { host: `localhost:${upstreamPort}` },
          },
          (res) => {
            let text = "";
            res.on("data", (chunk) => (text += chunk));
            res.on("end", () => resolve(text));
          },
        )
        .on("error", reject);
    });
    expect(body).toContain("upstream saw GET /over-unix");
    await proxy.close();
    expect(fs.existsSync(path.dirname(socketPath))).toBe(false);
  });

  it("answers 502 when an allowed plain-HTTP host is unreachable", async () => {
    const proxy = await proxyFor(["localhost"]);
    const res = await getThrough(proxy.port, `http://localhost:${await deadPort()}/`);
    expect(res.status).toBe(502);
    expect(proxy.blockedCount()).toBe(0);
  });

  it("gives up on an upstream proxy whose CONNECT answer never ends, and on one that hangs up", async () => {
    const chatty = net.createServer((socket) => {
      socket.once("data", () => socket.write(`HTTP/1.1 200 OK\r\n${"X-Pad: y\r\n".repeat(3000)}`));
    });
    const rude = net.createServer((socket) => socket.once("data", () => socket.destroy()));
    await new Promise<void>((resolve) => chatty.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => rude.listen(0, "127.0.0.1", resolve));
    const upstreamOf = (server: net.Server) =>
      new URL(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
    for (const server of [chatty, rude]) {
      const proxy = await startNetworkProxy(
        { allowedDomains: ["remote.test"] },
        { upstream: { https: upstreamOf(server), noProxy: [] } },
      );
      proxies.push(proxy);
      const res = await connectThrough(proxy.port, "remote.test:443");
      expect(res.status).toContain("502");
      res.socket.destroy();
    }
    await new Promise<void>((resolve) => chatty.close(() => resolve()));
    await new Promise<void>((resolve) => rude.close(() => resolve()));
  });

  it("tears the tunnel down when the far side fails after it was established", async () => {
    const flaky = net.createServer((socket) => {
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 OK\r\n\r\nhello");
        setTimeout(() => socket.resetAndDestroy(), 20);
      });
    });
    await new Promise<void>((resolve) => flaky.listen(0, "127.0.0.1", resolve));
    const proxy = await startNetworkProxy(
      { allowedDomains: ["remote.test"] },
      {
        upstream: {
          https: new URL(`http://127.0.0.1:${(flaky.address() as net.AddressInfo).port}`),
          noProxy: [],
        },
      },
    );
    proxies.push(proxy);
    const res = await connectThrough(proxy.port, "remote.test:443");
    expect(res.status).toBe("HTTP/1.1 200 Connection Established");
    const all = await readAll(res);
    expect(all).toContain("hello");
    await new Promise<void>((resolve) => flaky.close(() => resolve()));
  });

  it("bypasses the upstream for NO_PROXY wildcards and suffixes, and survives malformed credentials", async () => {
    const seen: string[] = [];
    const corp = http.createServer((req, res) => {
      seen.push(`${req.url} ${req.headers["proxy-authorization"] ?? "-"}`);
      res.end("corp");
    });
    await new Promise<void>((resolve) => corp.listen(0, "127.0.0.1", resolve));
    const corpUrl = (auth: string) => new URL(`http://${auth}127.0.0.1:${(corp.address() as net.AddressInfo).port}`);
    const suffix = await startNetworkProxy(
      { allowedDomains: ["*.internal.test", "outside.test"] },
      { upstream: { http: corpUrl("%E0%A4%A@"), noProxy: [".internal.test"] } },
    );
    const everything = await startNetworkProxy(
      { allowedDomains: ["outside.test"] },
      { upstream: { http: corpUrl(""), noProxy: ["*"] } },
    );
    proxies.push(suffix, everything);
    expect((await getThrough(suffix.port, "http://outside.test/a")).body).toBe("corp");
    expect(seen).toEqual([`http://outside.test/a Basic ${Buffer.from("%E0%A4%A:").toString("base64")}`]);
    // Bypassed hosts are dialled directly; these do not resolve, so the direct
    // attempt fails — and the upstream never hears of them.
    expect((await getThrough(suffix.port, "http://db.internal.test/b")).status).toBe(502);
    expect((await getThrough(everything.port, "http://outside.test/c")).status).toBe(502);
    expect(seen).toHaveLength(1);
    await new Promise<void>((resolve) => corp.close(() => resolve()));
  });
});

describe("network proxy registry", () => {
  it("shares one proxy per policy regardless of pattern order, and indexes it by port", async () => {
    const first = await ensureNetworkProxy({ allowedDomains: ["a.example", "b.example"] });
    const second = await ensureNetworkProxy({ allowedDomains: ["b.example", "a.example"] });
    const other = await ensureNetworkProxy({ allowedDomains: ["a.example"] });
    expect(second).toBe(first);
    expect(other).not.toBe(first);
    expect(networkProxyAt(first.port)).toBe(first);
    await closeNetworkProxiesForTests();
    expect(networkProxyAt(first.port)).toBeUndefined();
  });

  it("closes while a tunnel is still open", async () => {
    const proxy = await startNetworkProxy({ allowedDomains: ["localhost"] });
    const { socket } = await connectThrough(proxy.port, `localhost:${echoPort}`);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await proxy.close();
    await closed;
  });
});
