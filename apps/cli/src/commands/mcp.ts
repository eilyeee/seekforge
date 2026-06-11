import { createMcpClient } from "@seekforge/core";
import { loadConfig } from "../config.js";

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
