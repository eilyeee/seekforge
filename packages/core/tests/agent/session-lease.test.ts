import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireSessionLease,
  acquireWorkspaceSessionGuard,
  hasActiveSessionRuns,
  isSessionRunActive,
  sessionLeasesRoot,
  SessionBusyError,
} from "../../src/agent/session-lease.js";
import { deleteSession } from "../../src/agent/trace.js";

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "seekforge-session-lease-"));
}

function initializeLeaseRoot(workspace: string): string {
  const seed = acquireSessionLease(workspace, "seed");
  seed.release();
  return sessionLeasesRoot(workspace);
}

const children = new Set<ReturnType<typeof spawn>>();

afterEach(() => {
  for (const child of children) child.kill("SIGTERM");
  children.clear();
});

describe("session leases", () => {
  it("is exclusive and visible across processes", async () => {
    const workspace = makeWorkspace();
    const moduleUrl = pathToFileURL(resolve("src/agent/session-lease.ts")).href;
    const script = `
      import { acquireSessionLease } from ${JSON.stringify(moduleUrl)};
      const lease = acquireSessionLease(${JSON.stringify(workspace)}, "cross-process");
      process.on("SIGTERM", () => { lease.release(); process.exit(0); });
      console.log("ready");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: resolve("../.."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("lease holder did not start")), 10_000);
      child.once("error", reject);
      child.stderr?.once("data", (data) => reject(new Error(String(data))));
      child.stdout?.once("data", () => {
        clearTimeout(timer);
        resolveReady();
      });
    });

    expect(isSessionRunActive(workspace, "cross-process")).toBe(true);
    expect(hasActiveSessionRuns(workspace)).toBe(true);
    expect(() => acquireSessionLease(workspace, "cross-process")).toThrow(SessionBusyError);

    child.kill("SIGTERM");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    children.delete(child);
    expect(isSessionRunActive(workspace, "cross-process")).toBe(false);
  }, 20_000);

  it("gives malformed leases a grace period, then recovers them", () => {
    const workspace = makeWorkspace();
    const lock = join(initializeLeaseRoot(workspace), "malformed.lock");
    mkdirSync(lock, { mode: 0o700 });

    expect(isSessionRunActive(workspace, "malformed")).toBe(true);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(isSessionRunActive(workspace, "malformed")).toBe(false);

    const lease = acquireSessionLease(workspace, "malformed");
    lease.release();
  });

  it("recovers a reused PID when its process-start identity differs", () => {
    const workspace = makeWorkspace();
    const lock = join(initializeLeaseRoot(workspace), "reused.lock");
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        token: "stale-token",
        processIdentity: "not-this-process",
        createdAt: new Date().toISOString(),
      }),
    );

    expect(isSessionRunActive(workspace, "reused")).toBe(false);
    const lease = acquireSessionLease(workspace, "reused");
    lease.release();
  });

  it("recovers a stale recovery marker left by a crashed process", () => {
    const workspace = makeWorkspace();
    const recovery = join(initializeLeaseRoot(workspace), "recoverable.lock.recovery");
    mkdirSync(recovery, { mode: 0o700 });
    writeFileSync(
      join(recovery, "owner.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        token: "abandoned-recovery",
        processIdentity: "not-this-process",
        createdAt: new Date().toISOString(),
      }),
    );

    const lease = acquireSessionLease(workspace, "recoverable");
    expect(isSessionRunActive(workspace, "recoverable")).toBe(true);
    lease.release();
  });

  it("workspace guards reject existing runs and block new runs", () => {
    const workspace = makeWorkspace();
    const running = acquireSessionLease(workspace, "running");
    expect(() => acquireWorkspaceSessionGuard(workspace)).toThrow(SessionBusyError);
    running.release();

    const guard = acquireWorkspaceSessionGuard(workspace);
    try {
      expect(() => acquireSessionLease(workspace, "late-run")).toThrow(SessionBusyError);
    } finally {
      guard.release();
    }
    const late = acquireSessionLease(workspace, "late-run");
    late.release();
  });

  it("Core session mutators honor the same lease", () => {
    const workspace = makeWorkspace();
    mkdirSync(join(workspace, ".seekforge", "sessions", "mutating"), { recursive: true });
    const lease = acquireSessionLease(workspace, "mutating");
    try {
      expect(() => deleteSession(workspace, "mutating")).toThrow(SessionBusyError);
    } finally {
      lease.release();
    }
    expect(deleteSession(workspace, "mutating")).toBe(true);
  });

  it("rejects symlinked or non-private workspace lease roots", () => {
    const seedWorkspace = makeWorkspace();
    const parent = resolve(initializeLeaseRoot(seedWorkspace), "..");

    const symlinkWorkspace = makeWorkspace();
    const outside = mkdtempSync(join(tmpdir(), "seekforge-lease-outside-"));
    const symlinkRoot = sessionLeasesRoot(symlinkWorkspace);
    const broadWorkspace = makeWorkspace();
    const broadRoot = sessionLeasesRoot(broadWorkspace);
    try {
      symlinkSync(outside, symlinkRoot);
      expect(() => acquireSessionLease(symlinkWorkspace, "blocked")).toThrow(/Unsafe session lease path/);
      expect(readdirSync(outside)).toEqual([]);

      mkdirSync(broadRoot, { mode: 0o755 });
      expect(() => acquireSessionLease(broadWorkspace, "blocked")).toThrow(/permissions must be 0700/);
      expect(statSync(parent).mode & 0o077).toBe(0);
      expect(statSync(initializeLeaseRoot(seedWorkspace)).mode & 0o077).toBe(0);
    } finally {
      rmSync(symlinkRoot, { force: true });
      rmSync(broadRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps a live lease retryable when release cleanup initially fails", () => {
    const workspace = makeWorkspace();
    const lease = acquireSessionLease(workspace, "retry-release");
    const lock = join(sessionLeasesRoot(workspace), "retry-release.lock");
    renameSync(join(lock, "owner.json"), join(lock, "owner.saved"));

    lease.release();
    expect(isSessionRunActive(workspace, "retry-release")).toBe(true);
    expect(() => acquireSessionLease(workspace, "retry-release")).toThrow(SessionBusyError);

    renameSync(join(lock, "owner.saved"), join(lock, "owner.json"));
    lease.release();
    expect(isSessionRunActive(workspace, "retry-release")).toBe(false);
  });
});
