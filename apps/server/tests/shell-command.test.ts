import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runShellCommand } from "../src/shell-command.js";
import { makeWorkspace, waitUntil } from "./helpers.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

describe("runShellCommand", () => {
  it.each([
    ["successful", "exit 0"],
    ["failed", "exit 7"],
  ])("terminates background descendants after a %s direct-shell exit", async (_label, exit) => {
    if (process.platform === "win32") return;
    const workspace = makeWorkspace();
    const pidFile = join(workspace, "child.pid");
    const command = `(trap '' TERM; sleep 30) </dev/null >/dev/null 2>&1 & echo $! > child.pid; ${exit}`;

    if (exit === "exit 0") await expect(runShellCommand(command, workspace)).resolves.toBe("");
    else await expect(runShellCommand(command, workspace)).rejects.toThrow(/exit 7/);
    await waitUntil(() => existsSync(pidFile));
    const childPid = Number(readFileSync(pidFile, "utf8").trim());
    await waitUntil(() => !isProcessAlive(childPid));
  });

  it("rejects timeout output and terminates the entire process group", async () => {
    const workspace = makeWorkspace();
    const pidFile = join(workspace, "child.pid");
    const command = "(trap '' TERM; sleep 30) & echo $! > child.pid; printf partial-output; wait";

    await expect(runShellCommand(command, workspace, 100)).rejects.toThrow(/timed out/);
    await waitUntil(() => existsSync(pidFile));
    const childPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isSafeInteger(childPid)).toBe(true);
    await waitUntil(() => !isProcessAlive(childPid));
  });
});
