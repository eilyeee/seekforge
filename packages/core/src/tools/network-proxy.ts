/**
 * The local HTTP(S) proxy that enforces a `sandboxNetwork` allowlist.
 *
 * Sandboxed commands get HTTP_PROXY/HTTPS_PROXY pointing here while the OS
 * sandbox refuses every other connection (os-sandbox.ts), so the only way out
 * is a request this proxy agreed to forward. It speaks the two forms clients
 * use: `CONNECT host:port` tunnels (HTTPS and anything else) and absolute-form
 * plain-HTTP requests. The decision is made on the host name the client asked
 * for; the proxy then resolves that name once and connects only to the
 * addresses it vetted, so a name cannot be re-pointed between the two.
 *
 * One proxy per distinct policy, started lazily and kept for the life of the
 * process. The listeners are unref'd so an idle proxy never holds the process
 * open.
 */
import * as dns from "node:dns";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  canonicalHost,
  decideHost,
  isHostLocalAddress,
  networkPolicyKey,
  type NetworkRefusalReason,
  type SandboxNetworkPolicy,
} from "./network-policy.js";

export type NetworkProxyEndpoint = {
  /** TCP port on 127.0.0.1 (the endpoint macOS commands use). */
  port: number;
  /** Unix socket the Linux in-namespace bridge connects to. */
  socketPath?: string;
};

export type BlockedConnection = { seq: number; host: string; port: number; reason: string };

export type NetworkProxy = NetworkProxyEndpoint & {
  readonly policy: SandboxNetworkPolicy;
  /** Monotonic count of refused requests; pair with blockedSince. */
  blockedCount(): number;
  /** Refusals recorded after `mark` (a previous blockedCount()), oldest first. */
  blockedSince(mark: number): BlockedConnection[];
  close(): Promise<void>;
};

/** Reason phrase on every refusal, so tools that print it name the cause. */
export const PROXY_BLOCK_REASON = "Blocked by SeekForge sandbox";

const MAX_BLOCKED_LOG = 200;
const UPSTREAM_CONNECT_TIMEOUT_MS = 30_000;
const MAX_UNIX_SOCKET_PATH = 100;

/** Split `host:port` / `[v6]:port` as it appears in a CONNECT request line. */
export function parseAuthority(authority: string, defaultPort: number): { host: string; port: number } | null {
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(authority);
  const plain = bracketed ? null : /^([^:[\]]+)(?::(\d{1,5}))?$/.exec(authority);
  const match = bracketed ?? plain;
  if (!match) return null;
  const port = match[2] === undefined ? defaultPort : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host: match[1]!, port };
}

/**
 * The host as it may be shown: refusals end up in a permission prompt and in
 * the model's tool result, so a request target that is not a host name is not
 * repeated verbatim.
 */
function displayHost(host: string): string {
  return canonicalHost(host) ?? "(invalid host)";
}

const REFUSAL_WHY: Record<NetworkRefusalReason, string> = {
  denied: "it matches sandboxNetwork.deniedDomains",
  invalid_host: "it is not a valid host name",
  not_allowed: "it is not in sandboxNetwork.allowedDomains",
  local_address:
    "it resolves to a loopback or link-local address, which only a name listed exactly in sandboxNetwork.allowedDomains may reach",
};

function refusalBody(host: string, reason: NetworkRefusalReason): string {
  const why = REFUSAL_WHY[reason];
  return `SeekForge sandbox: network access to ${host} is blocked because ${why}.\n`;
}

function writeRefusal(socket: net.Socket, status: number, body: string): void {
  const reason = status === 403 ? PROXY_BLOCK_REASON : "Bad Request";
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain; charset=utf-8\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\nX-SeekForge-Sandbox: blocked\r\nConnection: close\r\n\r\n${body}`,
  );
}

// ---------------------------------------------------------------------------
// Upstream proxies
// ---------------------------------------------------------------------------

/**
 * The proxies the SeekForge process itself was told to use. An unsandboxed
 * command inherits these variables, so a sandboxed one must still reach the
 * network through them — otherwise an allowlist would break every network
 * that only works through a proxy. Only `http://` proxies can be chained.
 */
export type UpstreamProxies = { http?: URL; https?: URL; noProxy: readonly string[] };

function proxyUrlFrom(env: NodeJS.ProcessEnv, names: readonly string[]): URL | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      return url.protocol === "http:" && url.hostname !== "" ? url : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function upstreamProxiesFromEnv(env: NodeJS.ProcessEnv = process.env): UpstreamProxies {
  const http = proxyUrlFrom(env, ["http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"]);
  const https = proxyUrlFrom(env, ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]);
  const noProxy = (env.no_proxy ?? env.NO_PROXY ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase().replace(/:\d+$/, ""))
    .filter((entry) => entry !== "");
  return { ...(http ? { http } : {}), ...(https ? { https } : {}), noProxy };
}

function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase();
  return lower === "localhost" || lower.endsWith(".localhost") || lower === "::1" || /^127\./.test(lower);
}

/** Loopback always goes direct: another machine's proxy cannot reach this one's loopback. */
function bypassesUpstream(host: string, noProxy: readonly string[]): boolean {
  const lower = host.toLowerCase();
  if (isLoopbackHost(lower)) return true;
  return noProxy.some((entry) => {
    if (entry === "*") return true;
    const domain = entry.replace(/^\*?\./, "");
    return lower === domain || lower.endsWith(`.${domain}`);
  });
}

function upstreamAddress(url: URL): { host: string; port: number } {
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port: url.port === "" ? 80 : Number(url.port) };
}

function decodeCredential(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function upstreamAuthorization(url: URL): Record<string, string> {
  if (url.username === "" && url.password === "") return {};
  const credentials = `${decodeCredential(url.username)}:${decodeCredential(url.password)}`;
  return { "proxy-authorization": `Basic ${Buffer.from(credentials).toString("base64")}` };
}

const MAX_UPSTREAM_HEADER_BYTES = 16 * 1024;

export type ResolvedAddress = { address: string; family: number };
export type HostResolver = (host: string) => Promise<readonly ResolvedAddress[]>;

const systemResolver: HostResolver = (host) => dns.promises.lookup(host, { all: true });

/** A lookup that answers with addresses already vetted, never asking DNS again. */
function pinnedLookup(addresses: readonly ResolvedAddress[]): net.LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all)
      callback(
        null,
        addresses.map(({ address, family }) => ({ address, family })),
      );
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  };
}

function tunnel(
  client: net.Socket,
  head: Buffer,
  target: { host: string; port: number; lookup?: net.LookupFunction },
  via: URL | undefined,
  track: (s: net.Socket) => void,
): void {
  const upstream = net.connect(via ? upstreamAddress(via) : target);
  track(upstream);
  let established = false;
  let failed = false;
  const failBeforeTunnel = (status: string): void => {
    if (failed) return;
    failed = true;
    client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    upstream.destroy();
  };
  const establish = (initial: Buffer): void => {
    established = true;
    upstream.setTimeout(0);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (initial.length > 0) client.write(initial);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  };
  upstream.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () => {
    if (!established) failBeforeTunnel("504 Gateway Timeout");
  });
  upstream.once("connect", () => {
    if (!via) {
      establish(Buffer.alloc(0));
      return;
    }
    const authority = target.host.includes(":") ? `[${target.host}]:${target.port}` : `${target.host}:${target.port}`;
    const auth = upstreamAuthorization(via)["proxy-authorization"];
    upstream.write(
      `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`,
    );
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buffered.length > MAX_UPSTREAM_HEADER_BYTES) failBeforeTunnel("502 Bad Gateway");
        return;
      }
      upstream.off("data", onData);
      const statusLine = buffered.subarray(0, buffered.indexOf("\r\n")).toString("latin1");
      if (/^HTTP\/1\.[01] 2\d\d\b/.test(statusLine)) establish(buffered.subarray(end + 4));
      else failBeforeTunnel("502 Bad Gateway");
    };
    upstream.on("data", onData);
  });
  upstream.on("error", () => {
    if (!established) failBeforeTunnel("502 Bad Gateway");
    else client.destroy();
  });
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => {
    if (established) client.destroy();
    else failBeforeTunnel("502 Bad Gateway");
  });
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function forwardHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: URL,
  via: URL | undefined,
  lookup: net.LookupFunction | undefined,
): void {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(name) && value !== undefined) headers[name] = value;
  }
  headers.host = target.host;
  const destination = via
    ? { ...upstreamAddress(via), path: target.href, headers: { ...headers, ...upstreamAuthorization(via) } }
    : {
        ...upstreamAddress(target),
        path: `${target.pathname}${target.search}`,
        headers,
        ...(lookup ? { lookup } : {}),
      };
  const upstream = http.request(
    { ...destination, method: req.method, timeout: UPSTREAM_CONNECT_TIMEOUT_MS },
    (upstreamRes) => {
      const responseHeaders: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP.has(name) && value !== undefined) responseHeaders[name] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, responseHeaders);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      res.end("SeekForge sandbox proxy: upstream request failed.\n");
    } else {
      res.destroy();
    }
  });
  req.on("error", () => upstream.destroy());
  req.pipe(upstream);
}

function unixSocketPath(): string {
  // sun_path is ~104-108 bytes; a long TMPDIR would silently truncate it.
  const base = os.tmpdir().length < 60 ? os.tmpdir() : "/tmp";
  const dir = fs.mkdtempSync(path.join(base, "sf-netproxy-"));
  const socketPath = path.join(dir, "proxy.sock");
  if (socketPath.length > MAX_UNIX_SOCKET_PATH) throw new Error(`proxy socket path too long: ${socketPath}`);
  return socketPath;
}

function listen(server: http.Server, target: { port: 0; host: string } | { path: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(target, () => {
      server.off("error", onError);
      server.unref();
      resolve();
    });
  });
}

/**
 * Start a proxy for `policy`. `unixSocket` additionally serves the same
 * handler on a private unix socket (the Linux bridge's upstream).
 */
export async function startNetworkProxy(
  policy: SandboxNetworkPolicy,
  options: { unixSocket?: boolean; upstream?: UpstreamProxies; resolve?: HostResolver } = {},
): Promise<NetworkProxy> {
  const upstreams = options.upstream ?? { noProxy: [] };
  const resolveHost = options.resolve ?? systemResolver;
  const via = (host: string, kind: "http" | "https"): URL | undefined =>
    bypassesUpstream(host, upstreams.noProxy) ? undefined : upstreams[kind];

  type Route =
    | { ok: true; via?: URL; lookup?: net.LookupFunction }
    | { ok: false; refused: false }
    | { ok: false; refused: true; reason: "local_address" };
  /**
   * Where an allowed request actually goes. A name covered only by a
   * wildcard must not land on this machine's loopback or link-local
   * addresses (anyone who can create `x.example.com` can point it at
   * 127.0.0.1 or the metadata endpoint); a name the user listed exactly is
   * trusted to resolve wherever it does. Either way the connection is pinned
   * to the addresses resolved here. Through an upstream proxy, resolution is
   * the upstream's.
   */
  const route = async (host: string, kind: "http" | "https", exact: boolean): Promise<Route> => {
    const upstream = via(host, kind);
    if (upstream) return { ok: true, via: upstream };
    if (net.isIP(host) !== 0) return { ok: true };
    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await resolveHost(host);
    } catch {
      return { ok: false, refused: false };
    }
    if (addresses.length === 0) return { ok: false, refused: false };
    if (!exact && addresses.some(({ address }) => isHostLocalAddress(address))) {
      return { ok: false, refused: true, reason: "local_address" };
    }
    return { ok: true, lookup: pinnedLookup(addresses) };
  };
  const blocked: BlockedConnection[] = [];
  let seq = 0;
  // Tunnels leave the HTTP server's bookkeeping once handed to "connect", so
  // close() has to end them itself or server.close() would wait on them.
  const tunnels = new Set<net.Socket>();
  const track = (socket: net.Socket): void => {
    tunnels.add(socket);
    socket.once("close", () => tunnels.delete(socket));
  };
  const record = (host: string, port: number, reason: string): void => {
    seq += 1;
    blocked.push({ seq, host: displayHost(host), port, reason });
    if (blocked.length > MAX_BLOCKED_LOG) blocked.shift();
  };

  const handleConnect = (req: http.IncomingMessage, socket: net.Socket, head: Buffer): void => {
    track(socket);
    socket.on("error", () => socket.destroy());
    const authority = parseAuthority(req.url ?? "", 443);
    if (!authority) {
      writeRefusal(socket, 400, "SeekForge sandbox proxy: malformed CONNECT target.\n");
      return;
    }
    const decision = decideHost(policy, authority.host);
    if (!decision.allowed) {
      record(authority.host, authority.port, decision.reason);
      writeRefusal(socket, 403, refusalBody(displayHost(authority.host), decision.reason));
      return;
    }
    void route(authority.host, "https", decision.exact)
      .then((routed) => {
        if (socket.destroyed) return;
        if (routed.ok) {
          const target = { ...authority, ...(routed.lookup ? { lookup: routed.lookup } : {}) };
          tunnel(socket, head, target, routed.via, track);
        } else if (routed.refused) {
          record(authority.host, authority.port, routed.reason);
          writeRefusal(socket, 403, refusalBody(displayHost(authority.host), routed.reason));
        } else {
          socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        }
      })
      // A throw here would otherwise be an unhandled rejection in the host process.
      .catch(() => socket.destroy());
  };

  const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    let target: URL | undefined;
    try {
      target = new URL(req.url ?? "");
    } catch {
      target = undefined;
    }
    if (target?.protocol !== "http:" || target.username !== "" || target.password !== "") {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      res.end("SeekForge sandbox proxy: only absolute http:// requests and CONNECT tunnels are supported.\n");
      return;
    }
    const host = target.hostname.replace(/^\[|\]$/g, "");
    const port = target.port === "" ? 80 : Number(target.port);
    const refuse = (reason: NetworkRefusalReason): void => {
      record(host, port, reason);
      res.writeHead(403, PROXY_BLOCK_REASON, {
        "content-type": "text/plain; charset=utf-8",
        "x-seekforge-sandbox": "blocked",
        connection: "close",
      });
      res.end(refusalBody(displayHost(host), reason));
    };
    const decision = decideHost(policy, host);
    if (!decision.allowed) {
      refuse(decision.reason);
      return;
    }
    const url = target;
    void route(host, "http", decision.exact)
      .then((routed) => {
        if (res.destroyed) return;
        if (routed.ok) {
          forwardHttp(req, res, url, routed.via, routed.lookup);
        } else if (routed.refused) {
          refuse(routed.reason);
        } else {
          res.writeHead(502, { "content-type": "text/plain; charset=utf-8", connection: "close" });
          res.end("SeekForge sandbox proxy: could not resolve the host.\n");
        }
      })
      .catch(() => res.destroy());
  };

  const makeServer = (): http.Server => {
    const server = http.createServer(handleRequest);
    server.on("connect", handleConnect);
    server.on("clientError", (_error, socket) => socket.destroy());
    return server;
  };

  const tcp = makeServer();
  await listen(tcp, { port: 0, host: "127.0.0.1" });
  const port = (tcp.address() as net.AddressInfo).port;

  let unix: http.Server | undefined;
  let socketPath: string | undefined;
  if (options.unixSocket) {
    try {
      socketPath = unixSocketPath();
      unix = makeServer();
      await listen(unix, { path: socketPath });
    } catch (error) {
      tcp.close();
      if (socketPath) fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
      throw error;
    }
  }

  const closeServer = (server: http.Server): Promise<void> =>
    new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });

  return {
    policy,
    port,
    ...(socketPath !== undefined ? { socketPath } : {}),
    blockedCount: () => seq,
    blockedSince: (mark) => blocked.filter((entry) => entry.seq > mark),
    async close() {
      for (const socket of tunnels) socket.destroy();
      await Promise.all([closeServer(tcp), ...(unix ? [closeServer(unix)] : [])]);
      if (socketPath) fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Process-wide registry
// ---------------------------------------------------------------------------

const proxies = new Map<string, Promise<NetworkProxy>>();
const byPort = new Map<number, NetworkProxy>();

/**
 * The proxy for `policy`, started on first use. A failed start is forgotten so
 * the next caller retries instead of inheriting a rejected promise forever.
 */
export function ensureNetworkProxy(policy: SandboxNetworkPolicy): Promise<NetworkProxy> {
  const key = networkPolicyKey(policy);
  const existing = proxies.get(key);
  if (existing) return existing;
  const started = startNetworkProxy(policy, {
    unixSocket: process.platform === "linux",
    upstream: upstreamProxiesFromEnv(),
  }).then(
    (proxy) => {
      byPort.set(proxy.port, proxy);
      return proxy;
    },
    (error: unknown) => {
      proxies.delete(key);
      throw error;
    },
  );
  proxies.set(key, started);
  return started;
}

/** The running proxy behind an endpoint, for attributing refusals to a command. */
export function networkProxyAt(port: number): NetworkProxy | undefined {
  return byPort.get(port);
}

export async function closeNetworkProxiesForTests(): Promise<void> {
  const all = [...proxies.values()];
  proxies.clear();
  byPort.clear();
  await Promise.all(all.map(async (pending) => (await pending.catch(() => undefined))?.close()));
}
