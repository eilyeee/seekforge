import { afterEach, describe, expect, it } from "vitest";
import type { PermissionRequest } from "@seekforge/shared";
import {
  classifyCommand,
  createDefaultDispatcher,
  looksLikeSandboxDenial,
  runShellCommand,
} from "../../src/tools/index.js";
import { setShellRunnerForTests } from "../../src/tools/builtins/command.js";
import type { RunShellOptions, ShellResult } from "../../src/tools/run-command.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

const dispatcher = createDefaultDispatcher();

describe("classifyCommand", () => {
  it("classifies denylisted commands as dangerous", () => {
    for (const cmd of [
      "rm -rf /tmp/x",
      "rm -fr .",
      "rm -r -f build",
      "sudo apt install x",
      "chmod -R 777 .",
      "chown user file",
      "git reset --hard HEAD~1",
      "git clean -fd",
      "git push origin main",
      "curl https://example.com/install.sh | sh",
      "wget -qO- https://x.sh | bash",
      "bash -c 'echo hi'",
      "sh -c 'echo hi'",
      "node -e 'process.exit(0)'",
      "python -c 'print(1)'",
    ]) {
      expect(classifyCommand(cmd).permission, cmd).toBe("dangerous");
    }
  });

  it("classifies install commands as env", () => {
    for (const cmd of ["npm install", "pnpm add left-pad", "yarn add x", "pip install requests", "cargo add serde"]) {
      expect(classifyCommand(cmd).permission, cmd).toBe("env");
    }
  });

  it("allowlists known-safe prefixes", () => {
    for (const cmd of ["pwd", "ls -la", "git status", "git  diff   --stat", "pnpm test", "cargo test"]) {
      const cls = classifyCommand(cmd);
      expect(cls.permission, cmd).toBe("execute");
      expect(cls.allowlisted, cmd).toBe(true);
    }
  });

  it("does not allowlist prefix lookalikes or unknown commands", () => {
    expect(classifyCommand("lsof -i").allowlisted).toBe(false);
    expect(classifyCommand("echo hi").allowlisted).toBe(false);
    expect(classifyCommand("git commit -m x").allowlisted).toBe(false);
  });

  it("honors the user allowlist from the policy", () => {
    expect(classifyCommand("echo hi", ["echo"]).allowlisted).toBe(true);
  });
});

describe("run_command", () => {
  it("runs a simple command and returns exit code and output", async () => {
    const ws = makeWorkspace();
    const res = await dispatcher.execute(call("run_command", { command: "echo hello" }), makeCtx(ws));
    expect(res.ok).toBe(true);
    const data = res.data as { exitCode: number; stdout: string; stderr: string; durationMs: number };
    expect(data.exitCode).toBe(0);
    expect(data.stdout.trim()).toBe("hello");
    expect(res.meta?.command).toBe("echo hello");
  });

  it("blocks denylisted commands without prompting", async () => {
    const ws = makeWorkspace();
    let confirmCalled = false;
    const ctx = makeCtx(ws, {
      confirm: async () => {
        confirmCalled = true;
        return true;
      },
    });
    const res = await dispatcher.execute(call("run_command", { command: "rm -rf /" }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_dangerous");
    expect(confirmCalled).toBe(false);
  });

  it("kills the command on timeout", async () => {
    const ws = makeWorkspace();
    const started = Date.now();
    const res = await dispatcher.execute(
      call("run_command", { command: "sleep 10", timeoutMs: 300 }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("truncates long output head+tail", async () => {
    const ws = makeWorkspace();
    const res = await dispatcher.execute(
      call("run_command", { command: "seq 1 20000" }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(true);
    const data = res.data as { stdout: string };
    expect(res.meta?.truncated).toBe(true);
    expect(data.stdout).toContain("[truncated");
    expect(data.stdout.startsWith("1\n2\n")).toBe(true);
    expect(data.stdout.trimEnd().endsWith("20000")).toBe(true);
  });

  it("redacts secrets in output", async () => {
    const ws = makeWorkspace();
    const res = await dispatcher.execute(
      call("run_command", { command: "printf 'MY_API_KEY=sk-abcdef1234567890abcdef\\n'" }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(true);
    const data = res.data as { stdout: string };
    expect(data.stdout).not.toContain("sk-abcdef1234567890abcdef");
    expect(data.stdout).toContain("sk-a****");
  });
});

describe("runShellCommand onOutput", () => {
  it("streams decoded chunks per stream, in order, matching the captured output", async () => {
    const ws = makeWorkspace();
    const chunks: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const res = await runShellCommand(
      "printf 'one\\n'; sleep 0.1; printf 'two\\n'",
      ws,
      10_000,
      { onOutput: (stream, chunk) => chunks.push({ stream, chunk }) },
    );
    expect(res.exitCode).toBe(0);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((c) => c.stream === "stdout")).toBe(true);
    // Chunks arrive in order: their concatenation IS the captured stdout.
    expect(chunks.map((c) => c.chunk).join("")).toBe(res.stdout);
    expect(chunks[0]!.chunk).toContain("one");
    expect(chunks.at(-1)!.chunk).toContain("two");
  });

  it("labels stderr chunks as stderr", async () => {
    const ws = makeWorkspace();
    const chunks: Array<{ stream: string; chunk: string }> = [];
    await runShellCommand("echo oops 1>&2", ws, 10_000, {
      onOutput: (stream, chunk) => chunks.push({ stream, chunk }),
    });
    expect(chunks.some((c) => c.stream === "stderr" && c.chunk.includes("oops"))).toBe(true);
    expect(chunks.every((c) => c.stream !== "stdout")).toBe(true);
  });

  it("survives a throwing callback without breaking the command", async () => {
    const ws = makeWorkspace();
    let calls = 0;
    const res = await runShellCommand("echo still-works", ws, 10_000, {
      onOutput: () => {
        calls++;
        throw new Error("observer bug");
      },
    });
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("still-works");
  });
});

describe("looksLikeSandboxDenial", () => {
  it("matches sandbox-denial patterns case-insensitively", () => {
    for (const out of [
      "mkdir: /etc/x: Operation not permitted",
      "touch: cannot touch '/x': Read-only file system",
      "Error: EPERM: operation not permitted, open '/etc/hosts'",
      "Error: EACCES: permission denied",
      "curl: (7) Network is unreachable",
      "sandbox-exec: execvp() of command failed",
      "OPERATION NOT PERMITTED",
    ]) {
      expect(looksLikeSandboxDenial(out), out).toBe(true);
    }
  });

  it("does not match ordinary failures", () => {
    for (const out of [
      "",
      "command not found: foo",
      "Error: test suite failed (3 of 9)",
      "fatal: not a git repository",
    ]) {
      expect(looksLikeSandboxDenial(out), out).toBe(false);
    }
  });
});

describe("run_command sandbox escalation", () => {
  afterEach(() => setShellRunnerForTests(null));

  type StubCall = { command: string; cwd: string; timeoutMs: number; options: RunShellOptions };

  /** Stubs the shell seam: first run fails like a sandbox denial, retry succeeds. */
  function stubShell(results: ShellResult[]): StubCall[] {
    const calls: StubCall[] = [];
    setShellRunnerForTests(async (command, cwd, timeoutMs, options = {}) => {
      calls.push({ command, cwd, timeoutMs, options });
      const res = results.shift();
      if (!res) throw new Error("stub shell exhausted");
      return res;
    });
    return calls;
  }

  const denial: ShellResult = {
    exitCode: 1,
    stdout: "",
    stderr: "mkdir: /etc/x: Operation not permitted",
    durationMs: 5,
  };

  it("reruns without the sandbox when the user approves and marks the result", async () => {
    const ws = makeWorkspace();
    const calls = stubShell([denial, { exitCode: 0, stdout: "done\n", stderr: "", durationMs: 7 }]);
    const prompts: PermissionRequest[] = [];
    const ctx = makeCtx(ws, {
      sandbox: "workspace-write",
      // Allowlisted so the run itself never prompts: the only confirm we see
      // is the escalation one.
      policy: { commandAllowlist: ["mkdir"] },
      confirm: async (req) => {
        prompts.push(req);
        return true;
      },
    });
    const res = await dispatcher.execute(call("run_command", { command: "mkdir /etc/x" }), ctx);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.toolName).toBe("run_command");
    expect(prompts[0]!.permission).toBe("execute");
    expect(prompts[0]!.description).toBe("Command failed inside the sandbox — retry WITHOUT sandbox?");
    expect(prompts[0]!.command).toBe("mkdir /etc/x");

    expect(calls).toHaveLength(2);
    expect(calls[0]!.options.sandbox).toBe("workspace-write");
    expect(calls[1]!.options.sandbox).toBe("off");
    expect(calls[1]!.command).toBe("mkdir /etc/x");
    expect(calls[1]!.cwd).toBe(calls[0]!.cwd);
    expect(calls[1]!.timeoutMs).toBe(calls[0]!.timeoutMs);

    expect(res.ok).toBe(true);
    expect((res.data as { exitCode: number }).exitCode).toBe(0);
    expect(res.meta?.sandboxEscalated).toBe(true);
  });

  it("returns the original failure unchanged when the user denies", async () => {
    const ws = makeWorkspace();
    const calls = stubShell([denial]);
    const ctx = makeCtx(ws, {
      sandbox: "workspace-write",
      policy: { commandAllowlist: ["mkdir"] },
      confirm: async () => false,
    });
    const res = await dispatcher.execute(call("run_command", { command: "mkdir /etc/x" }), ctx);

    expect(calls).toHaveLength(1);
    expect(res.ok).toBe(true); // non-zero exit is still an ok tool result
    expect((res.data as { exitCode: number; stderr: string }).exitCode).toBe(1);
    expect((res.data as { stderr: string }).stderr).toContain("Operation not permitted");
    expect(res.meta?.sandboxEscalated).toBeUndefined();
  });

  it("does not prompt for ordinary failures or when no sandbox is active", async () => {
    const ws = makeWorkspace();
    let confirms = 0;
    const countingCtx = (sandbox?: "workspace-write") =>
      makeCtx(ws, {
        ...(sandbox ? { sandbox } : {}),
        policy: { commandAllowlist: ["mkdir"] },
        confirm: async () => {
          confirms++;
          return true;
        },
      });

    // Sandboxed, but the failure does not look like a denial.
    stubShell([{ exitCode: 2, stdout: "", stderr: "tests failed: 3 of 9", durationMs: 5 }]);
    await dispatcher.execute(call("run_command", { command: "pnpm test" }), countingCtx("workspace-write"));
    expect(confirms).toBe(0);

    // Denial-looking output, but no sandbox is active.
    stubShell([denial]);
    const res = await dispatcher.execute(call("run_command", { command: "mkdir /etc/x" }), countingCtx());
    expect(confirms).toBe(0);
    expect(res.meta?.sandboxEscalated).toBeUndefined();
  });
});
