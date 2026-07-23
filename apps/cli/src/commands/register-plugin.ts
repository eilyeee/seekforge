import type { Command } from "commander";
import {
  pluginCreateCommand,
  pluginInspectCommand,
  pluginInstallCommand,
  pluginListCommand,
  pluginRemoveCommand,
  pluginSetEnabledCommand,
  pluginValidateCommand,
} from "./plugin.js";

export function registerPluginCommands(program: Command): void {
  const plugin = program.command("plugin").alias("plugins").description("manage first-class SeekForge plugins");
  plugin
    .command("list", { isDefault: true })
    .option("--json", "print machine-readable plugin records")
    .description("list installed and project-discovered plugins")
    .action((opts: { json?: boolean }) => pluginListCommand(opts.json === true));
  plugin
    .command("inspect")
    .argument("<id>")
    .option("--json", "print the complete plugin record")
    .description("inspect a plugin manifest and approval state")
    .action((id: string, opts: { json?: boolean }) => pluginInspectCommand(id, opts.json === true));
  plugin
    .command("validate")
    .argument("<path>")
    .description("validate a local plugin without installing it")
    .action(pluginValidateCommand);
  plugin
    .command("create")
    .argument("<id>")
    .description("create a project plugin scaffold under .seekforge/plugins")
    .action(pluginCreateCommand);
  plugin
    .command("install")
    .argument("<path>", "local plugin directory")
    .option("-f, --force", "atomically replace an installed plugin; leaves it disabled")
    .description("install a reviewed local plugin into the user plugin store")
    .action((path: string, opts: { force?: boolean }) => pluginInstallCommand(path, opts.force === true));
  plugin
    .command("update")
    .argument("<path>", "updated local plugin directory")
    .description("update an installed plugin and require approval again")
    .action((path: string) => pluginInstallCommand(path, true));
  plugin
    .command("enable")
    .argument("<id>")
    .description("approve the current installed digest and enable its contributions")
    .action((id: string) => pluginSetEnabledCommand(id, true));
  plugin
    .command("disable")
    .argument("<id>")
    .description("disable all contributions from an installed plugin")
    .action((id: string) => pluginSetEnabledCommand(id, false));
  plugin
    .command("remove")
    .alias("rm")
    .argument("<id>")
    .description("uninstall a user plugin and remove its approval state")
    .action(pluginRemoveCommand);
}
