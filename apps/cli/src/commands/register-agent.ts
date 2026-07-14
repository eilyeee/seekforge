import type { Command } from "commander";
import { agentImportCommand, agentListCommand, agentShowCommand } from "./agent.js";

export function registerAgentCommands(program: Command): void {
  const agentCmd = program.command("agent").description("manage specialist subagents (dispatch_agent roster)");
  agentCmd
    .command("list", { isDefault: true })
    .description("list available agents (project > global)")
    .action(() => {
      agentListCommand();
    });
  agentCmd
    .command("show")
    .argument("<agent-id>")
    .description("print an agent's frontmatter fields and body")
    .action((id: string) => {
      agentShowCommand(id);
    });
  agentCmd
    .command("import")
    .argument("<path>", "agent .md file with YAML frontmatter (Claude Code / Meta_Kim format)")
    .option("-g, --global", "import into ~/.seekforge/agents (all projects) instead of this project")
    .option("-f, --force", "replace an existing agent with the same id")
    .description("import an external agent definition")
    .action((sourcePath: string, opts: { global?: boolean; force?: boolean }) => {
      agentImportCommand(sourcePath, opts);
    });
}
