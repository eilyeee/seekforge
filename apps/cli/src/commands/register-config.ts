import type { Command } from "commander";
import { configSetCommand, configShowCommand } from "./config.js";

export function registerConfigCommands(program: Command): void {
  const config = program.command("config").description("show or change configuration");
  config
    .command("show", { isDefault: true })
    .description("print merged config (api key masked)")
    .action(() => {
      configShowCommand();
    });
  config
    .command("set")
    .argument(
      "<key>",
      "apiKey | model | baseUrl | runtimeBin | commandAllowlist | sandbox | compaction | thinking | reasoningEffort",
    )
    .argument("<value>")
    .option("-g, --global", "write to your user config (~/.seekforge/config.json) instead of the project")
    .option("-u, --user", "alias for --global: write to your user config (~/.seekforge/config.json)")
    .description("set a config value (default: this project; --user/--global for all projects)")
    .action((key: string, value: string, opts: { global?: boolean; user?: boolean }) => {
      configSetCommand(key, value, { global: opts.global || opts.user });
    });
}
