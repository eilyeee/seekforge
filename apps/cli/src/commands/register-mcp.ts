import type { Command } from "commander";
import { mcpServeCommand } from "./mcp-serve.js";
import { mcpAddCommand, mcpListCommand, mcpRemoveCommand } from "./mcp.js";

export function registerMcpCommands(program: Command): void {
  const mcp = program.command("mcp").description("Model Context Protocol servers (mcpServers in config)");
  mcp
    .command("list", { isDefault: true })
    .option("--tools", "also print each tool's description")
    .description("list configured MCP servers and the tools they expose")
    .action(async (opts: { tools?: boolean }) => {
      await mcpListCommand(opts);
    });
  mcp
    .command("add")
    .argument("<name>", "server name (key under mcpServers)")
    .argument("<command...>", "command to spawn, then its args (e.g. npx -y @scope/server .)")
    .option("-g, --global", "write to ~/.seekforge/config.json instead of the project")
    // Treat everything after <name> literally so flags like -y belong to the
    // spawned command, not to seekforge. Put -g before the command, e.g.
    //   seekforge mcp add -g fs npx -y @scope/server .
    .passThroughOptions()
    .description("add a stdio MCP server to config")
    .action((name: string, command: string[], opts: { global?: boolean }) => {
      mcpAddCommand(name, command, opts);
    });
  mcp
    .command("remove")
    .alias("rm")
    .argument("<name>", "server name to remove")
    .option("-g, --global", "edit ~/.seekforge/config.json instead of the project")
    .description("remove an MCP server from config")
    .action((name: string, opts: { global?: boolean }) => {
      mcpRemoveCommand(name, opts);
    });

  program
    .command("mcp-serve")
    .option("--allow-write", "expose write/execute tools too and auto-approve them (TRUSTED callers only)")
    .description("run SeekForge as an MCP server on stdio (read-only tool set by default)")
    .addHelpText(
      "after",
      `
Add to another agent's mcpServers config:
  { "mcpServers": { "seekforge": { "command": "seekforge", "args": ["mcp-serve"] } } }
`,
    )
    .action(async (opts: { allowWrite?: boolean }) => {
      await mcpServeCommand(opts);
    });
}
