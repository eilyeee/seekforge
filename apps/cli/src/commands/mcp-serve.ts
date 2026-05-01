import { serveMcp } from "@seekforge/core";

export type McpServeOptions = {
  /** Expose the FULL tool set (write/run). Trusted callers only. */
  allowWrite?: boolean;
};

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
    `seekforge mcp-serve: ${readOnly ? "read-only" : "FULL ACCESS (trusted callers only)"} on ${workspace}\n`,
  );

  const server = serveMcp({ workspace, readOnly, input: process.stdin, output: process.stdout });

  await new Promise<void>((resolve) => {
    process.stdin.on("end", resolve);
    process.stdin.on("close", resolve);
  });
  server.close();
}
