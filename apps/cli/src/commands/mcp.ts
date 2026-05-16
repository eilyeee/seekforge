import { createMcpClient } from "@seekforge/core";
import { dim, fail } from "../colors.js";
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
    console.log('no MCP servers configured — add "mcpServers" to .seekforge/config.json');
    return;
  }

  for (const [name, serverConfig] of servers) {
    const commandLine = [serverConfig.command, ...(serverConfig.args ?? [])].join(" ");
    const trust = serverConfig.trusted ? "trusted" : "untrusted";
    const client = createMcpClient({ name, config: serverConfig });
    try {
      const tools = await client.listTools();
      console.log(`${name}  ${dim(`(${commandLine}, ${trust})`)}  ${tools.length} tool(s)`);
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
        `${name}  ${dim(`(${commandLine}, ${trust})`)}  error: ${err instanceof Error ? err.message : String(err)}`,
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
    fail("missing command for `mcp add`", {
      hint: "seekforge mcp add <name> <command> [args...]  e.g. seekforge mcp add fs npx -y @modelcontextprotocol/server-filesystem .",
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
  console.log(`added MCP server "${name}" (${commandLine}) to ${path}`);
  console.log(dim('note: new servers are untrusted by default — set "trusted": true in config to auto-approve their tools'));
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
  console.log(`removed MCP server "${name}" from ${path}`);
}
