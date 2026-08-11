import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerPluginCommands } from "../commands/register-plugin.js";

function pluginCommand(): Command {
  const program = new Command();
  registerPluginCommands(program);
  const plugin = program.commands.find((command) => command.name() === "plugin");
  if (!plugin) throw new Error("plugin command is not registered");
  return plugin;
}

describe("plugin CLI", () => {
  /**
   * `plugin update` is a force install and the only action that produces a
   * previous version, so the CLI has to be able to undo it; rollback used to be
   * reachable only from the Desktop.
   */
  it("registers the full install lifecycle including rollback and supply chain", () => {
    expect(pluginCommand().commands.map((command) => command.name())).toEqual([
      "list",
      "inspect",
      "validate",
      "create",
      "install",
      "update",
      "rollback",
      "supply-chain",
      "enable",
      "disable",
      "remove",
    ]);
  });

  it("requires a plugin id to roll back and offers machine-readable supply chain output", () => {
    const plugin = pluginCommand();
    const rollback = plugin.commands.find((command) => command.name() === "rollback");
    expect(rollback?.registeredArguments.map((argument) => argument.required)).toEqual([true]);
    const supplyChain = plugin.commands.find((command) => command.name() === "supply-chain");
    expect(supplyChain?.options.map((option) => option.long)).toContain("--json");
  });
});
