import type { Command } from "commander";
import { mcpLoginCommand, mcpLogoutCommand } from "./mcp-login.js";
import { mcpServeCommand } from "./mcp-serve.js";
import {
  mcpAddCommand,
  mcpAddJsonCommand,
  mcpApproveCommand,
  mcpGetCommand,
  mcpImportCommand,
  mcpListCommand,
  mcpRejectCommand,
  mcpRemoveCommand,
  mcpResetProjectChoicesCommand,
} from "./mcp.js";

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];
const SCOPE_HELP =
  "where to write: user (~/.seekforge), project (.seekforge/config.json, default), local (config.local.json)";

export function registerMcpCommands(program: Command): void {
  const mcp = program.command("mcp").description("Model Context Protocol servers (mcpServers in config)");
  mcp
    .command("list", { isDefault: true })
    .option("--tools", "also print each tool's description")
    .option("-y, --yes", "pre-authorize this folder (listing starts approved servers the checkout defines)")
    .description(
      "list configured MCP servers and the tools they expose (pending project servers are shown, not started)",
    )
    .action(async (opts: { tools?: boolean; yes?: boolean }) => {
      await mcpListCommand(opts);
    });
  mcp
    .command("get")
    .argument("<name>", "server name")
    .description("show one server's definition (unexpanded) and whether it connects automatically")
    .action((name: string) => {
      mcpGetCommand(name);
    });
  mcp
    .command("add")
    .argument("<name>", "server name (key under mcpServers)")
    .argument("<target...>", "stdio: command then its args (e.g. npx -y @scope/server .); http/sse: the url")
    .option("-t, --transport <kind>", "stdio (default), http, or sse")
    .option("-s, --scope <scope>", SCOPE_HELP)
    .option("-g, --global", "same as --scope user")
    .option("-e, --env <KEY=VALUE>", "environment variable for a stdio server (repeatable)", collect)
    .option("-H, --header <Name: value>", "HTTP header for an http/sse server (repeatable)", collect)
    .option("--trust", "connect automatically: user scope writes trusted: true, project/local approves it here")
    // Treat everything after <name> literally so flags like -y belong to the
    // spawned command, not to seekforge. Put options before the name, e.g.
    //   seekforge mcp add -g fs npx -y @scope/server .
    .passThroughOptions()
    .description("add an MCP server (stdio, http or sse) to config")
    .action(
      (
        name: string,
        target: string[],
        opts: {
          global?: boolean;
          scope?: string;
          transport?: string;
          env?: string[];
          header?: string[];
          trust?: boolean;
        },
      ) => {
        mcpAddCommand(name, target, opts);
      },
    );
  mcp
    .command("add-json")
    .argument("<name>", "server name (key under mcpServers)")
    .argument("<json>", 'one server definition as JSON, e.g. \'{"type":"http","url":"https://example.com/mcp"}\'')
    .option("-s, --scope <scope>", SCOPE_HELP)
    .option("-g, --global", "same as --scope user")
    .option("--trust", "connect automatically: user scope writes trusted: true, project/local approves it here")
    .description("add an MCP server from a JSON definition (Claude Code format)")
    .action((name: string, json: string, opts: { global?: boolean; scope?: string; trust?: boolean }) => {
      mcpAddJsonCommand(name, json, opts);
    });
  mcp
    .command("import")
    .option("--from <source>", "claude-desktop or claude-code (default: both)")
    .option("-y, --yes", "write without asking (the list is still printed)")
    .option("--no-trust", "import the servers untrusted (default: trusted, as they were in Claude)")
    .description("import MCP servers from Claude Desktop / Claude Code into ~/.seekforge/config.json")
    .action(async (opts: { from?: string; yes?: boolean; trust?: boolean }) => {
      await mcpImportCommand(opts);
    });
  mcp
    .command("approve")
    .argument("<name>", "a server this repository defines")
    .option("-y, --yes", "approve without asking (the definition is still printed)")
    .description("let a repository-defined server connect automatically in this workspace")
    .action(async (name: string, opts: { yes?: boolean }) => {
      await mcpApproveCommand(name, opts);
    });
  mcp
    .command("reject")
    .argument("<name>", "a server this repository defines")
    .description("keep a repository-defined server from connecting in this workspace")
    .action((name: string) => {
      mcpRejectCommand(name);
    });
  mcp
    .command("reset-project-choices")
    .description("forget every approve/reject decision for this workspace")
    .action(() => {
      mcpResetProjectChoicesCommand();
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
    .option("-s, --scope <scope>", SCOPE_HELP)
    .option("-g, --global", "same as --scope user")
    .description("remove an MCP server from config")
    .action((name: string, opts: { global?: boolean; scope?: string }) => {
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
