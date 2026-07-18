import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { startServer } from "@seekforge/server";
import { t } from "../i18n.js";

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
  // SEEKFORGE_STATIC_DIR lets an embedder point at the built web UI explicitly.
  // The Tauri sidecar (a bun --compile binary) sets this to the bundled UI
  // resources, because the default `import.meta.url`-relative lookup cannot find
  // a real on-disk dist from inside a compiled binary's virtual FS.
  const envStatic = process.env.SEEKFORGE_STATIC_DIR;
  const staticDir = envStatic && envStatic.length > 0 ? resolve(envStatic) : undefined;
  const { port, token, close } = await startServer({ workspaces, port: opts.port, staticDir });

  console.log(t("cmd.serve.url", { port: String(port), token }));
  console.log(t("cmd.serve.workspaces", { count: workspaces.length }));
  for (const ws of workspaces) console.log(`  - ${ws}`);
  console.log(t("cmd.serve.pressCtrlC"));

  let closing = false;
  let shutdownPromiseCleanup = (): void => {};
  const shutdownPromise = new Promise<void>((resolve, reject) => {
    const shutdown = (): void => {
      if (closing) process.exit(130);
      closing = true;
      console.error(t("render.shuttingDown"));
      void Promise.resolve().then(close).then(resolve, reject);
    };
    shutdownPromiseCleanup = () => {
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
  try {
    await shutdownPromise;
  } finally {
    shutdownPromiseCleanup();
  }
}
