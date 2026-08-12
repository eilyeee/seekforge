import { createMcpClient } from "@seekforge/core";
import { dim, fail } from "../colors.js";
import { t } from "../i18n.js";
import { resolveConfig } from "../config.js";
import {
  addMcpServer,
  ConfigParseError,
  mcpConfigPath,
  readConfigDoc,
  removeMcpServer,
  writeConfigDoc,
} from "../mcp-config.js";
import { ensureWorkspaceAuthorized } from "./run.js";

/**
 * `seekforge mcp list` — spawn each configured server, handshake, and list
 * its tool names. A failing server shows its error and the listing continues.
 *
 * Listing is not a read: every entry is started, so an entry that came out of
 * the checkout's `.seekforge/config.json` means this command runs a command the
 * repository chose. `mcp add` writes there by default, so those entries are
 * ordinarily the user's own — the thing that separates them from a hostile
 * clone's is whether anybody has vouched for this folder. So when any listed
 * server is repository-owned, take the same folder-access consent `run`, `repl`,
 * `loop` and `graph` take before touching the checkout (`-y` pre-authorizes).
 * Servers from the user's own global/`--settings` config need no such gate.
 */
export async function mcpListCommand(opts: { tools?: boolean; yes?: boolean }): Promise<void> {
  const projectPath = process.cwd();
  const { config, mcpOrigins } = resolveConfig(projectPath);
  const servers = Object.entries(config.mcpServers ?? {});
  if (servers.length === 0) {
    console.log(t("cmd.mcp.none"));
    return;
  }
  const fromRepository = servers.some(([name]) => mcpOrigins[name] === "repository");
  if (fromRepository && !(await ensureWorkspaceAuthorized(projectPath, { yes: opts.yes === true, machine: false }))) {
    return;
  }

  for (const [name, serverConfig] of servers) {
    const commandLine = [serverConfig.command, ...(serverConfig.args ?? [])].join(" ");
    const trustLabel = `${serverConfig.trusted ? t("cmd.mcp.trusted") : t("cmd.mcp.untrusted")}, ${
      mcpOrigins[name] === "repository" ? t("cmd.mcp.fromRepository") : t("cmd.mcp.fromUser")
    }`;
    const client = createMcpClient({ name, config: serverConfig });
    try {
      const tools = await client.listTools();
      console.log(t("cmd.mcp.serverLine", { name, cmd: commandLine, trust: trustLabel, count: tools.length }));
      for (const tool of tools) {
        if (opts.tools) {
          const firstLine = (tool.description ?? "").split("\n")[0] ?? "";
          console.log(`  ${tool.name}  ${dim(firstLine)}`);
        } else {
          console.log(`  ${tool.name}`);
        }
      }
    } catch (err) {
      console.error(
        t("cmd.mcp.serverError", {
          name,
          cmd: commandLine,
          trust: trustLabel,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      client.dispose();
    }
  }
}

/**
 * `seekforge mcp add <name> <command...>` — append a stdio server to
 * mcpServers in .seekforge/config.json (or ~/.seekforge with --global).
 * The first token after <name> is the command, the rest are its args.
 */
export function mcpAddCommand(name: string, commandTokens: string[], opts: { global?: boolean }): void {
  if (commandTokens.length === 0) {
    fail(t("err.missingCommandMcp"), {
      hint: t("err.missingCommandMcpHint"),
    });
    return;
  }
  const [command, ...args] = commandTokens;
  const path = mcpConfigPath(process.cwd(), opts.global ?? false);
  try {
    const next = addMcpServer(readConfigDoc(path), name, command ?? "", args);
    writeConfigDoc(path, next);
  } catch (err) {
    if (err instanceof ConfigParseError) {
      fail(t("err.mcpConfigInvalidJson", { path: err.path }));
      return;
    }
    fail(err instanceof Error ? err.message : String(err));
    return;
  }
  const commandLine = [command, ...args].join(" ");
  console.log(t("status.addedMcp", { name, cmd: commandLine, path }));
  console.log(dim(t("status.mcpUntrustedNote")));
}

/**
 * `seekforge mcp remove <name>` — delete a server from mcpServers in
 * .seekforge/config.json (or ~/.seekforge with --global).
 */
export function mcpRemoveCommand(name: string, opts: { global?: boolean }): void {
  const path = mcpConfigPath(process.cwd(), opts.global ?? false);
  try {
    const next = removeMcpServer(readConfigDoc(path), name);
    writeConfigDoc(path, next);
  } catch (err) {
    if (err instanceof ConfigParseError) {
      fail(t("err.mcpConfigInvalidJson", { path: err.path }));
      return;
    }
    fail(err instanceof Error ? err.message : String(err));
    return;
  }
  console.log(t("status.removedMcp", { name, path }));
}
