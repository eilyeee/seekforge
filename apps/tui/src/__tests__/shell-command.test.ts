import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_SHELL_OUTPUT_BYTES, runShellCommand } from "../shell-command.js";

describe("runShellCommand", () => {
  it("captures output and exit status", async () => {
    await expect(runShellCommand("printf hello; exit 7", process.cwd())).resolves.toEqual({
      output: "hello",
      exitCode: 7,
    });
  });

  it("bounds output", async () => {
    const command = `${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(${MAX_SHELL_OUTPUT_BYTES + 1}))'`;
    const result = await runShellCommand(command, process.cwd());
    expect(result.output).toContain("output exceeded");
    expect(result.exitCode).toBe(1);
  });

  it("settles after timeout when a descendant retains the pipes", async () => {
    const started = Date.now();
    const result = await runShellCommand("sleep 10 &", process.cwd(), 50);
    expect(result.output).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("cleans descendants after a successful shell exit", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "seekforge-tui-shell-descendant-"));
    const pidFile = join(dir, "pid");
    let pid = 0;
    try {
      const command = `sleep 10 </dev/null >/dev/null 2>&1 & printf %s $! > ${JSON.stringify(pidFile)}`;
      await expect(runShellCommand(command, dir)).resolves.toEqual({ output: "(no output)", exitCode: 0 });
      pid = Number(readFileSync(pidFile, "utf8"));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 10));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
          throw error;
        }
      }
      throw new Error(`descendant ${pid} remained alive`);
    } finally {
      if (pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
