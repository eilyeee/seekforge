import type { Command } from "commander";
import {
  pluginCreateCommand,
  pluginInspectCommand,
  pluginInstallCommand,
  pluginListCommand,
  pluginMarketplaceAddCommand,
  pluginMarketplaceListCommand,
  pluginMarketplaceRemoveCommand,
  pluginRemoveCommand,
  pluginRollbackCommand,
  pluginSetEnabledCommand,
  pluginSupplyChainCommand,
  pluginValidateCommand,
} from "./plugin.js";

const PLUGIN_SOURCE_HELP =
  "local directory, git URL (https://, ssh://, git@host:path, file://; optional #ref), " +
  "https .tar.gz/.tgz/.zip archive, or <plugin>@<marketplace>";

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
    .argument("<source>", PLUGIN_SOURCE_HELP)
    .option("-f, --force", "atomically replace an installed plugin; leaves it disabled")
    .description("install a plugin into the user plugin store (disabled until its digest is approved)")
    .action((source: string, opts: { force?: boolean }) => pluginInstallCommand(source, opts.force === true));
  plugin
    .command("update")
    .argument("<source>", PLUGIN_SOURCE_HELP)
    .description("update an installed plugin and require approval again")
    .action((source: string) => pluginInstallCommand(source, true));
  plugin
    .command("rollback")
    .argument("<id>")
    .description("restore the previous installed version of a plugin; leaves it disabled")
    .action(pluginRollbackCommand);
  plugin
    .command("supply-chain")
    .option("--json", "print the machine-readable supply-chain report")
    .description("report plugin integrity, compatibility and rollback availability")
    .action((opts: { json?: boolean }) => pluginSupplyChainCommand(opts.json === true));
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

  const marketplace = plugin
    .command("marketplace")
    .description("manage plugin marketplaces (catalogs for `plugin install <name>@<marketplace>`)");
  marketplace
    .command("add")
    .argument("<source>", "git URL (https://, ssh://, git@host:path, file://; optional #ref) or local directory")
    .option("--name <name>", "register under this name instead of the manifest's name")
    .option("-f, --force", "replace a marketplace with the same name")
    .description("register a marketplace that ships .claude-plugin/marketplace.json")
    .action((source: string, opts: { name?: string; force?: boolean }) => pluginMarketplaceAddCommand(source, opts));
  marketplace
    .command("remove")
    .alias("rm")
    .argument("<name>")
    .description("unregister a marketplace and delete its cached copy (installed plugins stay)")
    .action(pluginMarketplaceRemoveCommand);
  marketplace
    .command("list", { isDefault: true })
    .option("--json", "print machine-readable marketplace records")
    .description("list registered marketplaces and the plugins they offer")
    .action((opts: { json?: boolean }) => pluginMarketplaceListCommand(opts.json === true));
}
