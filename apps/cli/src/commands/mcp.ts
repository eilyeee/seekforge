import { createMcpClient } from "@seekforge/core";
import { loadConfig } from "../config.js";
import {
  addMcpServer,
  mcpConfigPath,
  readConfigDoc,
  removeMcpServer,
  writeConfigDoc,
} from "../mcp-config.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

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
      console.log(`${name}  ${DIM}(${commandLine}, ${trust})${RESET}  ${tools.length} tool(s)`);
      for (const tool of tools) {
        if (opts.tools) {
          const firstLine = (tool.description ?? "").split("\n")[0] ?? "";
          console.log(`  ${tool.name}  ${DIM}${firstLine}${RESET}`);
        } else {
          console.log(`  ${tool.name}`);
        }
      }
    } catch (err) {
      console.error(
        `${name}  ${DIM}(${commandLine}, ${trust})${RESET}  error: ${err instanceof Error ? err.message : String(err)}`,
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
    console.error('usage: seekforge mcp add <name> <command> [args...]\n  e.g. seekforge mcp add fs npx -y @modelcontextprotocol/server-filesystem .');
    process.exitCode = 1;
    return;
  }
  const [command, ...args] = commandTokens;
  const path = mcpConfigPath(process.cwd(), opts.global ?? false);
  try {
    const next = addMcpServer(readConfigDoc(path), name, command ?? "", args);
    writeConfigDoc(path, next);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  const commandLine = [command, ...args].join(" ");
  console.log(`added MCP server "${name}" (${commandLine}) to ${path}`);
  console.log(`${DIM}note: new servers are untrusted by default — set "trusted": true in config to auto-approve their tools${RESET}`);
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
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  console.log(`removed MCP server "${name}" from ${path}`);
}
