import { createMcpClient } from "@seekforge/core";
import { dim, fail } from "../colors.js";
import { t } from "../i18n.js";
import { loadConfig } from "../config.js";
import {
  addMcpServer,
  mcpConfigPath,
  readConfigDoc,
  removeMcpServer,
  writeConfigDoc,
} from "../mcp-config.js";

/**
 * `seekforge mcp list` — spawn each configured server, handshake, and list
 * its tool names. A failing server shows its error and the listing continues.
 */
export async function mcpListCommand(opts: { tools?: boolean }): Promise<void> {
  const config = loadConfig(process.cwd());
  const servers = Object.entries(config.mcpServers ?? {});
  if (servers.length === 0) {
    console.log(t("cmd.mcp.none"));
    return;
  }

  for (const [name, serverConfig] of servers) {
    const commandLine = [serverConfig.command, ...(serverConfig.args ?? [])].join(" ");
    const trustLabel = serverConfig.trusted ? t("cmd.mcp.trusted") : t("cmd.mcp.untrusted");
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
        t("cmd.mcp.serverError", { name, cmd: commandLine, trust: trustLabel, error: err instanceof Error ? err.message : String(err) }),
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
export function mcpAddCommand(
  name: string,
  commandTokens: string[],
  opts: { global?: boolean },
): void {
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
    fail(err instanceof Error ? err.message : String(err));
    return;
  }
  console.log(t("status.removedMcp", { name, path }));
}
