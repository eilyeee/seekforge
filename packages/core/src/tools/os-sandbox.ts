/**
 * OS-level command sandboxing (opt-in): wraps `/bin/sh -c <command>` with the
 * platform sandbox so shell commands cannot write outside the workspace.
 *
 *   - darwin: sandbox-exec (seatbelt) with a deny-by-default file-write profile
 *     that re-allows temp dirs and, for write levels, the workspace.
 *   - linux: bwrap with a read-only root and /tmp writable; write levels also
 *     bind the workspace writable. "restricted" also unshares the network.
 *
 * Levels:
 *   - "off" (or absent): no wrapper — current behavior.
 *   - "read-only": workspace is read-only; temp dirs remain writable.
 *   - "workspace-write": file writes confined to workspace + temp dirs.
 *   - "restricted": workspace-write plus no network.
 *
 * A profile's network may also be a domain allowlist: the kernel then refuses
 * every connection except to a local proxy (network-proxy.ts) that forwards
 * only allowed hosts. seatbelt permits exactly that loopback port; bwrap's
 * fresh network namespace cannot reach the host at all, so a small in-namespace
 * forwarder bridges its loopback port to the proxy's unix socket.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { networkPolicyKey, type SandboxNetworkPolicy } from "./network-policy.js";
import { ensureNetworkProxy, type NetworkProxyEndpoint } from "./network-proxy.js";

export type SandboxLevel = "off" | "read-only" | "workspace-write" | "restricted";

/** Network reachable only through the allowlist proxy. */
export type SandboxNetworkAllowlist = SandboxNetworkPolicy & {
  /** Set once the proxy listens. An allowlist without it has no way out: no network. */
  proxy?: NetworkProxyEndpoint;
};

export type SandboxNetwork = "inherit" | "deny" | SandboxNetworkAllowlist;

export type SandboxProfile = {
  filesystem: "read-only" | "workspace-write";
  network: SandboxNetwork;
  /** Explicit additional writable roots. They are never inferred from commands. */
  writablePaths?: string[];
};

export type SandboxCapabilityProbe = {
  platform: string;
  available: boolean;
  binary?: "sandbox-exec" | "bwrap";
  filesystemIsolation: boolean;
  networkIsolation: boolean;
  reason?: string;
};

/** Wrapper prefix to prepend before ["/bin/sh", "-c", command]. */
export type SandboxSpec = { bin: string; args: string[] };

/** Per-process cache of PATH lookups (sandbox-exec / bwrap). */
const availabilityCache = new Map<string, boolean>();

function binaryOnPath(bin: string): boolean {
  const cached = availabilityCache.get(bin);
  if (cached !== undefined) return cached;
  let found = false;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      found = true;
      break;
    } catch {
      // not here — keep looking
    }
  }
  availabilityCache.set(bin, found);
  return found;
}

/** Test seam: override the binary availability check (null restores default). */
let availabilityCheck: (bin: string) => boolean = binaryOnPath;
export function setSandboxAvailabilityCheckForTests(fn: ((bin: string) => boolean) | null): void {
  availabilityCheck = fn ?? binaryOnPath;
}

/** Seatbelt profiles use double-quoted strings: escape backslashes and quotes. */
function escapeSeatbeltPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Both kernels match sandbox path rules against the *resolved* path, so the
 * policy has to name the resolved workspace. On macOS /tmp is a symlink to
 * /private/tmp: a "read-only" workspace emitted as `/tmp/ws` is never matched by
 * its own deny rule, while the broad `/private/tmp` write allowance is — which
 * silently makes a read-only workspace writable. Falls back to the literal path
 * when the workspace cannot be resolved, so an unresolvable path keeps the
 * stricter behavior instead of dropping out of the policy.
 */
function resolveWorkspace(workspace: string): string {
  return realpathOrNull(workspace) ?? workspace;
}

export function normalizeProfile(input: Exclude<SandboxLevel, "off"> | SandboxProfile): SandboxProfile {
  if (typeof input !== "string") return input;
  return {
    filesystem: input === "read-only" ? "read-only" : "workspace-write",
    network: input === "restricted" ? "deny" : "inherit",
  };
}

function composeNetwork(networks: readonly SandboxNetwork[]): SandboxNetwork {
  if (networks.includes("deny")) return "deny";
  const allowlists = networks.filter((network): network is SandboxNetworkAllowlist => typeof network === "object");
  if (allowlists.length === 0) return "inherit";
  // Two different allowlists would need a proxy enforcing both; there is none,
  // so the composition falls to the stricter answer both agree on.
  const first = allowlists[0]!;
  const key = networkPolicyKey(first);
  if (allowlists.some((policy) => networkPolicyKey(policy) !== key)) return "deny";
  return allowlists.find((policy) => policy.proxy !== undefined) ?? first;
}

/** Compose restrictions; restrictive filesystem/network settings win. */
export function composeSandboxProfiles(...profiles: SandboxProfile[]): SandboxProfile {
  return {
    filesystem: profiles.some((profile) => profile.filesystem === "read-only") ? "read-only" : "workspace-write",
    network: composeNetwork(profiles.map((profile) => profile.network)),
    writablePaths: [...new Set(profiles.flatMap((profile) => profile.writablePaths ?? []))],
  };
}

/**
 * The sandbox a run's commands get: the configured level, narrowed to a domain
 * allowlist when one is configured, with the user's additional directories
 * writable when the level allows writes at all.
 *
 * An absent level with a network policy means `workspace-write`: the policy
 * needs a sandbox to hold it, and that is the only reading of the config that
 * enforces what was written. An explicit "off" stays off — the user turned the
 * whole mechanism off. `restricted` keeps its no-network rule; an allowlist
 * never widens a level.
 */
export function sandboxForRun(
  level: SandboxLevel | SandboxProfile | undefined,
  options: { network?: SandboxNetworkPolicy; writablePaths?: readonly string[] } = {},
): SandboxLevel | SandboxProfile | undefined {
  if (level === "off") return "off";
  const network = options.network;
  const writable = options.writablePaths ?? [];
  if (level === undefined && network === undefined) return undefined;
  const base = normalizeProfile(level ?? "workspace-write");
  const extras: SandboxProfile[] = [];
  if (network !== undefined) {
    extras.push({
      filesystem: "workspace-write",
      network: {
        allowedDomains: network.allowedDomains,
        ...(network.deniedDomains ? { deniedDomains: network.deniedDomains } : {}),
      },
    });
  }
  if (writable.length > 0 && base.filesystem === "workspace-write") {
    extras.push({ filesystem: "workspace-write", network: "inherit", writablePaths: [...writable] });
  }
  if (extras.length === 0 && level !== undefined) return level;
  return composeSandboxProfiles(base, ...extras);
}

/**
 * Start (or reuse) the proxy an allowlist profile needs and return the profile
 * with its endpoint filled in. A proxy that cannot start leaves the network
 * denied rather than open.
 */
export async function resolveSandboxNetwork(
  sandbox: SandboxLevel | SandboxProfile | undefined,
): Promise<SandboxLevel | SandboxProfile | undefined> {
  if (sandbox === undefined || typeof sandbox === "string") return sandbox;
  const network = sandbox.network;
  if (typeof network !== "object" || network.proxy !== undefined) return sandbox;
  try {
    const proxy = await ensureNetworkProxy(network);
    return {
      ...sandbox,
      network: {
        ...network,
        proxy: { port: proxy.port, ...(proxy.socketPath !== undefined ? { socketPath: proxy.socketPath } : {}) },
      },
    };
  } catch {
    return { ...sandbox, network: "deny" };
  }
}

/** The proxy endpoint a resolved sandbox routes traffic through, if any. */
export function sandboxProxyEndpoint(
  sandbox: SandboxLevel | SandboxProfile | undefined,
): NetworkProxyEndpoint | undefined {
  if (sandbox === undefined || typeof sandbox === "string" || typeof sandbox.network !== "object") return undefined;
  return sandbox.network.proxy;
}

/** True when the sandbox limits the network (fully or to an allowlist). */
export function sandboxRestrictsNetwork(sandbox: SandboxLevel | SandboxProfile | undefined): boolean {
  if (sandbox === undefined || sandbox === "off") return false;
  return normalizeProfile(sandbox).network !== "inherit";
}

export function probeSandboxCapabilities(platform: string = process.platform): SandboxCapabilityProbe {
  if (platform === "darwin") {
    const available = availabilityCheck("sandbox-exec");
    return {
      platform,
      available,
      ...(available ? { binary: "sandbox-exec" as const } : { reason: "sandbox-exec was not found on PATH" }),
      filesystemIsolation: available,
      networkIsolation: available,
    };
  }
  if (platform === "linux") {
    const available = availabilityCheck("bwrap");
    return {
      platform,
      available,
      ...(available ? { binary: "bwrap" as const } : { reason: "bwrap was not found on PATH" }),
      filesystemIsolation: available,
      networkIsolation: available,
    };
  }
  return {
    platform,
    available: false,
    filesystemIsolation: false,
    networkIsolation: false,
    reason: `OS sandboxing is unsupported on ${platform}`,
  };
}

/** Hosts a proxied command reaches directly: its own loopback, never the proxy. */
const NO_PROXY_HOSTS = "localhost,127.0.0.1,::1";

/** Environment that points every common client at the allowlist proxy. */
export function proxyEnvironment(port: number): Record<string, string> {
  const url = `http://127.0.0.1:${port}`;
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    all_proxy: url,
    NO_PROXY: NO_PROXY_HOSTS,
    no_proxy: NO_PROXY_HOSTS,
    // Node >= 24 routes fetch/http through the variables above only when asked.
    NODE_USE_ENV_PROXY: "1",
  };
}

/** Writable roots: temp dirs + /dev, and workspace for write-capable levels. */
function darwinWritablePaths(profile: SandboxProfile, workspace: string): string[] {
  const candidates = [
    ...(profile.filesystem === "read-only" ? [] : [workspace]),
    ...(profile.writablePaths ?? []).map(realpathOrNull),
    os.tmpdir(),
    process.env.TMPDIR !== undefined ? realpathOrNull(process.env.TMPDIR) : null,
    "/private/tmp",
    "/dev",
  ];
  const unique: string[] = [];
  for (const c of candidates) {
    if (c !== null && c !== "" && !unique.includes(c)) unique.push(c);
  }
  return unique;
}

function buildSeatbeltProfile(profile: SandboxProfile, workspace: string): string {
  const lines = ["(version 1)", "(allow default)", "(deny file-write*)"];
  for (const p of darwinWritablePaths(profile, workspace)) {
    lines.push(`(allow file-write* (subpath "${escapeSeatbeltPath(p)}"))`);
  }
  // A workspace may itself live below TMPDIR. Re-apply its stronger read-only
  // rule after the broad temporary-directory allowances.
  if (profile.filesystem === "read-only") {
    lines.push(`(deny file-write* (subpath "${escapeSeatbeltPath(workspace)}"))`);
  }
  if (profile.network !== "inherit") lines.push("(deny network*)");
  const proxy = typeof profile.network === "object" ? profile.network.proxy : undefined;
  if (proxy !== undefined) {
    lines.push(`(allow network-outbound (remote ip "localhost:${proxy.port}"))`);
  }
  return lines.join("\n");
}

function seatbeltArgs(profile: SandboxProfile, workspace: string): string[] {
  const args = ["-p", buildSeatbeltProfile(profile, workspace)];
  const proxy = typeof profile.network === "object" ? profile.network.proxy : undefined;
  if (proxy === undefined) return args;
  return [
    ...args,
    "/usr/bin/env",
    ...Object.entries(proxyEnvironment(proxy.port)).map(([name, value]) => `${name}=${value}`),
  ];
}

/**
 * Runs inside the bwrap network namespace: listens on the namespace's own
 * loopback at the proxy port, pipes each connection to the host proxy's unix
 * socket, and only then starts the command, exiting with its status. argv:
 * <socket> <port> <command...>.
 */
export const NAMESPACE_BRIDGE_SCRIPT = [
  'const net=require("net"),{spawn}=require("child_process"),os=require("os");',
  "const [sock,port,...cmd]=process.argv.slice(1);",
  "const server=net.createServer((c)=>{const u=net.connect(sock);",
  "const end=()=>{c.destroy();u.destroy()};",
  'c.on("error",end);u.on("error",end);c.on("close",end);u.on("close",end);',
  "c.pipe(u);u.pipe(c)});",
  'server.on("error",(e)=>{process.stderr.write("SeekForge sandbox: network bridge failed: "+e.message+"\\n");process.exit(126)});',
  'server.listen(Number(port),"127.0.0.1",()=>{',
  'const child=spawn(cmd[0],cmd.slice(1),{stdio:"inherit"});',
  'child.on("error",(e)=>{process.stderr.write("SeekForge sandbox: "+e.message+"\\n");process.exit(127)});',
  'child.on("exit",(code,signal)=>process.exit(code??128+(os.constants.signals[signal]||0)))});',
].join("");

function buildBwrapArgs(profile: SandboxProfile, workspace: string): string[] {
  const proxy = typeof profile.network === "object" ? profile.network.proxy : undefined;
  // Linux reaches the proxy only through its unix socket; an endpoint without
  // one cannot be bridged, so it gets no network at all.
  const bridge = proxy?.socketPath !== undefined ? { port: proxy.port, socketPath: proxy.socketPath } : undefined;
  const args = [
    "--ro-bind",
    "/",
    "/",
    ...(profile.filesystem === "read-only" ? [] : ["--bind", workspace, workspace]),
    ...(profile.writablePaths ?? []).flatMap((candidate) => {
      const root = realpathOrNull(candidate);
      return root ? ["--bind", root, root] : [];
    }),
    "--bind",
    "/tmp",
    "/tmp",
    // Later nested mounts override the writable /tmp bind for a workspace
    // located below /tmp.
    ...(profile.filesystem === "read-only" ? ["--ro-bind", workspace, workspace] : []),
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--die-with-parent",
  ];
  if (profile.network !== "inherit") args.push("--unshare-net");
  if (bridge !== undefined) {
    const socketDir = path.dirname(bridge.socketPath);
    args.push("--bind", socketDir, socketDir);
    for (const [name, value] of Object.entries(proxyEnvironment(bridge.port))) {
      args.push("--setenv", name, value);
    }
    args.push(process.execPath, "-e", NAMESPACE_BRIDGE_SCRIPT, bridge.socketPath, String(bridge.port));
  }
  return args;
}

/**
 * Builds the sandbox wrapper for a platform, or null when unavailable
 * (unknown platform, level "off", or the sandbox binary is missing).
 */
export function buildSandboxSpec(
  level: SandboxLevel | SandboxProfile,
  workspace: string,
  platform: string = process.platform,
): SandboxSpec | null {
  if (level === "off") return null;
  const profile = normalizeProfile(level);
  if (platform === "darwin") {
    if (!availabilityCheck("sandbox-exec")) return null;
    return { bin: "sandbox-exec", args: seatbeltArgs(profile, resolveWorkspace(workspace)) };
  }
  if (platform === "linux") {
    if (!availabilityCheck("bwrap")) return null;
    return { bin: "bwrap", args: buildBwrapArgs(profile, resolveWorkspace(workspace)) };
  }
  return null;
}

/**
 * Wraps a `/bin/sh -c` command line with the platform sandbox. Falls back to
 * plain sh when no sandbox applies (level off/absent or wrapper unavailable);
 * callers that must not run unsandboxed should check `sandboxed`.
 */
export function sandboxedShell(
  command: string,
  level: SandboxLevel | SandboxProfile | undefined,
  workspace: string,
): { bin: string; args: string[]; sandboxed: boolean } {
  const spec = level !== undefined ? buildSandboxSpec(level, workspace) : null;
  if (!spec) return { bin: "/bin/sh", args: ["-c", command], sandboxed: false };
  return { bin: spec.bin, args: [...spec.args, "/bin/sh", "-c", command], sandboxed: true };
}
