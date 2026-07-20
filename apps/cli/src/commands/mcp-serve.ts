import { serveMcp } from "@seekforge/core";
import { t } from "../i18n.js";

export type McpServeOptions = {
  /** Expose the FULL tool set (write/run). Trusted callers only. */
  allowWrite?: boolean;
};

export function waitForStdinEnd(stream: NodeJS.ReadStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      stream.removeListener("end", done);
      stream.removeListener("close", done);
      stream.removeListener("error", failed);
    };
    const done = (): void => {
      cleanup();
      resolve();
    };
    const failed = (error: Error): void => {
      cleanup();
      reject(error);
    };
    if (stream.readableEnded) {
      done();
      return;
    }
    if (stream.destroyed) {
      failed((stream as NodeJS.ReadStream & { errored?: Error | null }).errored ?? new Error("stdin closed"));
      return;
    }
    stream.once("end", done);
    stream.once("close", done);
    stream.once("error", failed);
  });
}

/**
 * `seekforge mcp-serve` — run SeekForge AS an MCP server on stdio so another
 * agent can use this workspace's tools. Read-only by default; --allow-write
 * exposes write/execute tools and auto-approves them (trusted callers only —
 * the caller effectively gets a shell in this workspace).
 *
 * Protocol traffic owns stdout; all diagnostics go to stderr. Stays alive
 * until the client closes our stdin (the standard MCP stdio lifecycle).
 */
export async function mcpServeCommand(opts: McpServeOptions): Promise<void> {
  const readOnly = opts.allowWrite !== true;
  const workspace = process.cwd();
  process.stderr.write(
    `${t("cmd.mcpServe.header", { mode: readOnly ? t("cmd.mcpServe.readOnly") : t("cmd.mcpServe.fullAccess"), workspace })}\n`,
  );

  const server = serveMcp({ workspace, readOnly, input: process.stdin, output: process.stdout });

  try {
    await waitForStdinEnd(process.stdin);
  } finally {
    server.close();
  }
}
