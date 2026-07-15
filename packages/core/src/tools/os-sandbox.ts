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
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type SandboxLevel = "off" | "read-only" | "workspace-write" | "restricted";

export type SandboxProfile = {
  filesystem: "read-only" | "workspace-write";
  network: "inherit" | "deny";
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

function normalizeProfile(input: Exclude<SandboxLevel, "off"> | SandboxProfile): SandboxProfile {
  if (typeof input !== "string") return input;
  return {
    filesystem: input === "read-only" ? "read-only" : "workspace-write",
    network: input === "restricted" ? "deny" : "inherit",
  };
}

/** Compose restrictions; restrictive filesystem/network settings win. */
export function composeSandboxProfiles(...profiles: SandboxProfile[]): SandboxProfile {
  return {
    filesystem: profiles.some((profile) => profile.filesystem === "read-only") ? "read-only" : "workspace-write",
    network: profiles.some((profile) => profile.network === "deny") ? "deny" : "inherit",
    writablePaths: [...new Set(profiles.flatMap((profile) => profile.writablePaths ?? []))],
  };
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
  if (profile.network === "deny") lines.push("(deny network*)");
  return lines.join("\n");
}

function buildBwrapArgs(profile: SandboxProfile, workspace: string): string[] {
  const args = [
    "--ro-bind", "/", "/",
    ...(profile.filesystem === "read-only" ? [] : ["--bind", workspace, workspace]),
    ...(profile.writablePaths ?? []).flatMap((candidate) => {
      const root = realpathOrNull(candidate);
      return root ? ["--bind", root, root] : [];
    }),
    "--bind", "/tmp", "/tmp",
    // Later nested mounts override the writable /tmp bind for a workspace
    // located below /tmp.
    ...(profile.filesystem === "read-only" ? ["--ro-bind", workspace, workspace] : []),
    "--dev", "/dev",
    "--proc", "/proc",
    "--die-with-parent",
  ];
  if (profile.network === "deny") args.push("--unshare-net");
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
    return { bin: "sandbox-exec", args: ["-p", buildSeatbeltProfile(profile, workspace)] };
  }
  if (platform === "linux") {
    if (!availabilityCheck("bwrap")) return null;
    return { bin: "bwrap", args: buildBwrapArgs(profile, workspace) };
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
