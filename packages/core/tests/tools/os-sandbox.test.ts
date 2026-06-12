import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSandboxSpec,
  sandboxedShell,
  setSandboxAvailabilityCheckForTests,
} from "../../src/tools/os-sandbox.js";
import { runShellCommand } from "../../src/tools/run-command.js";
import { createBackgroundTasks } from "../../src/tools/background.js";
import { ToolError } from "../../src/tools/errors.js";
import { makeWorkspace } from "./helpers.js";

afterEach(() => setSandboxAvailabilityCheckForTests(null));

const allAvailable = () => setSandboxAvailabilityCheckForTests(() => true);
const noneAvailable = () => setSandboxAvailabilityCheckForTests(() => false);

describe("buildSandboxSpec", () => {
  it("returns null for level off, unknown platforms, and missing binaries", () => {
    allAvailable();
    expect(buildSandboxSpec("off", "/ws", "darwin")).toBeNull();
    expect(buildSandboxSpec("workspace-write", "/ws", "win32")).toBeNull();
    expect(buildSandboxSpec("restricted", "/ws", "freebsd")).toBeNull();
    noneAvailable();
    expect(buildSandboxSpec("workspace-write", "/ws", "darwin")).toBeNull();
    expect(buildSandboxSpec("workspace-write", "/ws", "linux")).toBeNull();
  });

  it("builds a darwin seatbelt profile that denies writes outside the workspace", () => {
    allAvailable();
    const spec = buildSandboxSpec("workspace-write", "/tmp/my workspace", "darwin");
    expect(spec).not.toBeNull();
    expect(spec!.bin).toBe("sandbox-exec");
    expect(spec!.args[0]).toBe("-p");
    const profile = spec!.args[1]!;
    expect(profile).toContain("(version 1)");
    expect(profile).toContain("(allow default)");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(allow file-write* (subpath "/tmp/my workspace"))');
    expect(profile).toContain(`(allow file-write* (subpath "${os.tmpdir()}"))`);
    expect(profile).toContain('(allow file-write* (subpath "/private/tmp"))');
    expect(profile).toContain('(allow file-write* (subpath "/dev"))');
    expect(profile).not.toContain("(deny network*)");
  });

  it("restricted on darwin additionally denies network", () => {
    allAvailable();
    const profile = buildSandboxSpec("restricted", "/ws", "darwin")!.args[1]!;
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain("(deny network*)");
  });

  it("escapes double quotes and backslashes in seatbelt paths", () => {
    allAvailable();
    const profile = buildSandboxSpec("workspace-write", '/ws/we"ird\\dir', "darwin")!.args[1]!;
    expect(profile).toContain('(subpath "/ws/we\\"ird\\\\dir")');
  });

  it("builds bwrap args on linux, with --unshare-net only when restricted", () => {
    allAvailable();
    const ww = buildSandboxSpec("workspace-write", "/ws", "linux")!;
    expect(ww.bin).toBe("bwrap");
    expect(ww.args).toEqual([
      "--ro-bind", "/", "/",
      "--bind", "/ws", "/ws",
      "--bind", "/tmp", "/tmp",
      "--dev", "/dev",
      "--proc", "/proc",
      "--die-with-parent",
    ]);
    const restricted = buildSandboxSpec("restricted", "/ws", "linux")!;
    expect(restricted.args).toEqual([...ww.args, "--unshare-net"]);
  });
});

describe("sandboxedShell", () => {
  it("falls back to plain /bin/sh when level is off or absent", () => {
    allAvailable();
    for (const level of [undefined, "off"] as const) {
      const shell = sandboxedShell("echo hi", level, "/ws");
      expect(shell).toEqual({ bin: "/bin/sh", args: ["-c", "echo hi"], sandboxed: false });
    }
  });

  it("falls back to plain /bin/sh when the sandbox binary is missing", () => {
    noneAvailable();
    const shell = sandboxedShell("echo hi", "workspace-write", "/ws");
    expect(shell.sandboxed).toBe(false);
    expect(shell.bin).toBe("/bin/sh");
  });

  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "wraps the shell with the sandbox prefix on supported platforms",
    () => {
      allAvailable();
      const shell = sandboxedShell("echo hi", "workspace-write", "/ws");
      expect(shell.sandboxed).toBe(true);
      expect(shell.bin).toBe(process.platform === "darwin" ? "sandbox-exec" : "bwrap");
      expect(shell.args.slice(-3)).toEqual(["/bin/sh", "-c", "echo hi"]);
    },
  );
});

describe("sandbox requested but unavailable", () => {
  it("runShellCommand rejects instead of running unsandboxed", async () => {
    noneAvailable();
    const ws = makeWorkspace();
    await expect(runShellCommand("echo hi", ws, 5_000, { sandbox: "workspace-write" })).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
  });

  it("background start throws instead of running unsandboxed", () => {
    noneAvailable();
    const ws = makeWorkspace();
    const bg = createBackgroundTasks();
    try {
      expect(() => bg.start({ command: "echo hi", cwd: ws, sandbox: "restricted" })).toThrow(ToolError);
    } finally {
      bg.disposeAll();
    }
  });

  it("runShellCommand still runs plain when sandbox is off/absent", async () => {
    noneAvailable();
    const ws = makeWorkspace();
    const res = await runShellCommand("echo plain", ws, 5_000, { sandbox: "off" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("plain");
  });
});

const hasSeatbelt =
  process.platform === "darwin" && spawnSync("/usr/bin/which", ["sandbox-exec"]).status === 0;

describe("seatbelt integration (darwin only)", () => {
  it.skipIf(!hasSeatbelt)(
    "workspace-write allows writes inside the workspace and blocks them outside",
    () => {
      const ws = makeWorkspace();
      const outside = fs.mkdtempSync(path.join(os.homedir(), ".seekforge-sbx-test-"));
      try {
        const inside = sandboxedShell(`echo ok > "${path.join(ws, "in.txt")}"`, "workspace-write", ws);
        const resIn = spawnSync(inside.bin, inside.args, { cwd: ws });
        expect(inside.sandboxed).toBe(true);
        expect(resIn.status).toBe(0);
        expect(fs.readFileSync(path.join(ws, "in.txt"), "utf8").trim()).toBe("ok");

        const outsideFile = path.join(outside, "out.txt");
        const out = sandboxedShell(`echo nope > "${outsideFile}"`, "workspace-write", ws);
        const resOut = spawnSync(out.bin, out.args, { cwd: ws });
        expect(resOut.status).not.toBe(0);
        expect(fs.existsSync(outsideFile)).toBe(false);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
        fs.rmSync(ws, { recursive: true, force: true });
      }
    },
  );
});
