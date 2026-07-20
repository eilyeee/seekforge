import { spawn } from "node:child_process";

/** Runs an interactive inherited-stdio command without an unhandled spawn error. */
export function runInheritedCommand(command: string, args: string[], cwd = process.cwd()): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    try {
      const child = spawn(command, args, { cwd, stdio: "inherit" });
      child.once("error", (error) => {
        process.stderr.write(`${error.message}\n`);
        finish((error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1);
      });
      child.once("close", (code) => finish(code ?? 1));
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      finish(1);
    }
  });
}
