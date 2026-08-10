import { serveMcp } from "@seekforge/core";
import { configureCliTools } from "../agent-factory.js";
import { loadConfig } from "../config.js";
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
 *
 * The workspace config is read here for the same reason every other CLI entry
 * point reads it (see agent-factory.createCliAgentDeps): the user's sandbox,
 * hooks, permission rules and tool configuration must not depend on which
 * command opened the workspace. Only the layers a repository cannot write
 * reach this transport — sanitizeProjectConfig already strips `hooks`,
 * `sandbox` and `commandAllowlist` from project/local layers and keeps only
 * their deny rules — and plugin hooks are deliberately NOT merged: unlike
 * `seekforge run`, mcp-serve's default is the read-only tool set, and a
 * repository-owned hook would turn it back into arbitrary command execution.
 */
export async function mcpServeCommand(opts: McpServeOptions): Promise<void> {
  const readOnly = opts.allowWrite !== true;
  const workspace = process.cwd();
  const config = loadConfig(workspace);
  configureCliTools(config, workspace);
  process.stderr.write(
    `${t("cmd.mcpServe.header", { mode: readOnly ? t("cmd.mcpServe.readOnly") : t("cmd.mcpServe.fullAccess"), workspace })}\n`,
  );

  const server = serveMcp({
    workspace,
    readOnly,
    input: process.stdin,
    output: process.stdout,
    ...(config.permissionRules ? { permissionRules: config.permissionRules } : {}),
    ...(config.commandAllowlist ? { commandAllowlist: config.commandAllowlist } : {}),
    ...(config.hooks ? { hooks: config.hooks } : {}),
    ...(config.sandbox ? { sandbox: config.sandbox } : {}),
  });

  try {
    await waitForStdinEnd(process.stdin);
  } finally {
    server.close();
  }
}
