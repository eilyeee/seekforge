import { Command } from "commander";

const program = new Command();

program
  .name("seekforge")
  .description("A local-first coding agent powered by DeepSeek.")
  .version("0.0.1");

program
  .command("run")
  .argument("<task>", "development task to perform")
  .description("run a development task in the current project")
  .action(async (_task: string) => {
    console.error("seekforge run: agent loop not wired up yet (Phase 0 in progress).");
    process.exitCode = 1;
  });

program.parseAsync();
