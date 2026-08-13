import type { Command } from "commander";
import { mcpLoginCommand, mcpLogoutCommand } from "./mcp-login.js";
import { mcpServeCommand } from "./mcp-serve.js";
import { mcpAddCommand, mcpListCommand, mcpRemoveCommand } from "./mcp.js";

export function registerMcpCommands(program: Command): void {
  const mcp = program.command("mcp").description("Model Context Protocol servers (mcpServers in config)");
  mcp
    .command("list", { isDefault: true })
    .option("--tools", "also print each tool's description")
    .option("-y, --yes", "pre-authorize this folder (listing starts servers the checkout may define)")
    .description("list configured MCP servers and the tools they expose")
    .action(async (opts: { tools?: boolean; yes?: boolean }) => {
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
    .command("login")
    .argument("<name>", "remote server name (key under mcpServers)")
    .option("--scope <scope>", "space-separated OAuth scopes (default: the server's advertised scopes)")
    .option("--client-id <id>", "pre-registered OAuth client id (default: dynamic registration)")
    .option("--client-secret <secret>", "client secret for a confidential pre-registered client")
    .description("authorize a remote MCP server interactively (OAuth 2.1 + PKCE)")
    .addHelpText(
      "after",
      `
The refresh token is stored in ~/.seekforge/mcp-oauth.json (owner-only), never
in .seekforge/config.json. Servers configured with an explicit "oauth" block
already carry their own credentials and are rejected here.
`,
    )
    .option("-y, --yes", "pre-authorize this folder (a repository-defined server picks the authorization URL)")
    .action(async (name: string, opts: { scope?: string; clientId?: string; clientSecret?: string; yes?: boolean }) => {
      await mcpLoginCommand(name, opts);
    });
  mcp
    .command("logout")
    .argument("<name>", "remote server name to forget")
    .description("delete the stored OAuth credential for an MCP server")
    .action((name: string) => {
      mcpLogoutCommand(name);
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
