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

/** Writable roots: temp dirs + /dev, and workspace for write-capable levels. */
function darwinWritablePaths(level: Exclude<SandboxLevel, "off">, workspace: string): string[] {
  const candidates = [
    ...(level === "read-only" ? [] : [workspace]),
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

function buildSeatbeltProfile(level: Exclude<SandboxLevel, "off">, workspace: string): string {
  const lines = ["(version 1)", "(allow default)", "(deny file-write*)"];
  for (const p of darwinWritablePaths(level, workspace)) {
    lines.push(`(allow file-write* (subpath "${escapeSeatbeltPath(p)}"))`);
  }
  if (level === "restricted") lines.push("(deny network*)");
  return lines.join("\n");
}

function buildBwrapArgs(level: Exclude<SandboxLevel, "off">, workspace: string): string[] {
  const args = [
    "--ro-bind", "/", "/",
    ...(level === "read-only" ? [] : ["--bind", workspace, workspace]),
    "--bind", "/tmp", "/tmp",
    "--dev", "/dev",
    "--proc", "/proc",
    "--die-with-parent",
  ];
  if (level === "restricted") args.push("--unshare-net");
  return args;
}

/**
 * Builds the sandbox wrapper for a platform, or null when unavailable
 * (unknown platform, level "off", or the sandbox binary is missing).
 */
export function buildSandboxSpec(
  level: SandboxLevel,
  workspace: string,
  platform: string = process.platform,
): SandboxSpec | null {
  if (level === "off") return null;
  if (platform === "darwin") {
    if (!availabilityCheck("sandbox-exec")) return null;
    return { bin: "sandbox-exec", args: ["-p", buildSeatbeltProfile(level, workspace)] };
  }
  if (platform === "linux") {
    if (!availabilityCheck("bwrap")) return null;
    return { bin: "bwrap", args: buildBwrapArgs(level, workspace) };
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
  level: SandboxLevel | undefined,
  workspace: string,
): { bin: string; args: string[]; sandboxed: boolean } {
  const spec = level !== undefined ? buildSandboxSpec(level, workspace) : null;
  if (!spec) return { bin: "/bin/sh", args: ["-c", command], sandboxed: false };
  return { bin: spec.bin, args: [...spec.args, "/bin/sh", "-c", command], sandboxed: true };
}
