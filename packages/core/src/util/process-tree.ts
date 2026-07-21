import { spawn, type ChildProcess } from "node:child_process";

/** Best-effort hard termination of a child and every process below it. */
export function killProcessTree(child: Pick<ChildProcess, "pid" | "kill">): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref();
    } catch {
      child.kill("SIGKILL");
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
