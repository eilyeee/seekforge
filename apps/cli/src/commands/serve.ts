import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { startServer } from "@seekforge/server";

export type ServeOptions = {
  port: number;
  /** Workspace paths to host (deduped, resolved, missing skipped). Empty = cwd. */
  workspaces: string[];
};

/**
 * Resolves the requested workspace paths: dedupe, make absolute, warn+skip
 * missing ones, and default to the cwd when none are given.
 */
function resolveWorkspaces(paths: string[]): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const abs = resolve(p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (!existsSync(abs)) {
      console.error(`skipping missing workspace: ${abs}`);
      continue;
    }
    resolved.push(abs);
  }
  if (resolved.length === 0) resolved.push(process.cwd());
  return resolved;
}

/** Starts the local agent server for one or more workspaces; stays alive until Ctrl+C. */
export async function serveCommand(opts: ServeOptions): Promise<void> {
  const workspaces = resolveWorkspaces(opts.workspaces);
  const { port, token, close } = await startServer({ workspaces, port: opts.port });

  console.log(`SeekForge server: http://127.0.0.1:${port}/?token=${token}`);
  console.log(`Serving ${workspaces.length} workspace(s) on 127.0.0.1 only:`);
  for (const ws of workspaces) console.log(`  - ${ws}`);
  console.log("Press Ctrl+C to stop.");

  await new Promise<void>((resolve) => {
    let closing = false;
    const shutdown = () => {
      if (closing) process.exit(130);
      closing = true;
      console.error("\nshutting down…");
      void close().then(resolve);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
