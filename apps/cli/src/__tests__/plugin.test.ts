import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pluginInstallCommand,
  pluginMarketplaceAddCommand,
  pluginMarketplaceListCommand,
  pluginMarketplaceRemoveCommand,
} from "../commands/plugin.js";
import { registerPluginCommands } from "../commands/register-plugin.js";

const originalHome = process.env.SEEKFORGE_HOME;
const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  if (originalHome === undefined) delete process.env.SEEKFORGE_HOME;
  else process.env.SEEKFORGE_HOME = originalHome;
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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
      "marketplace",
    ]);
  });

  it("accepts any install source and requires one for install and update", () => {
    const plugin = pluginCommand();
    for (const name of ["install", "update"]) {
      const command = plugin.commands.find((candidate) => candidate.name() === name);
      expect(command?.registeredArguments.map((argument) => [argument.name(), argument.required])).toEqual([
        ["source", true],
      ]);
      expect(command?.registeredArguments[0]?.description).toMatch(/git URL.*archive.*<plugin>@<marketplace>/);
    }
  });

  it("registers marketplace add/remove/list with list as the default", () => {
    const marketplace = pluginCommand().commands.find((command) => command.name() === "marketplace");
    expect(marketplace?.commands.map((command) => command.name())).toEqual(["add", "remove", "list"]);
    const add = marketplace?.commands.find((command) => command.name() === "add");
    expect(add?.registeredArguments.map((argument) => argument.required)).toEqual([true]);
    expect(add?.options.map((option) => option.long)).toEqual(["--name", "--force"]);
    const remove = marketplace?.commands.find((command) => command.name() === "remove");
    expect(remove?.aliases()).toEqual(["rm"]);
    const list = marketplace?.commands.find((command) => command.name() === "list");
    expect(list?.options.map((option) => option.long)).toEqual(["--json"]);
    expect((marketplace as unknown as { _defaultCommandName?: string })._defaultCommandName).toBe("list");
  });

  it("requires a plugin id to roll back and offers machine-readable supply chain output", () => {
    const plugin = pluginCommand();
    const rollback = plugin.commands.find((command) => command.name() === "rollback");
    expect(rollback?.registeredArguments.map((argument) => argument.required)).toEqual([true]);
    const supplyChain = plugin.commands.find((command) => command.name() === "supply-chain");
    expect(supplyChain?.options.map((option) => option.long)).toContain("--json");
  });
});

describe("plugin install sources and marketplaces", () => {
  function captureOutput(): { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void out.push(String(line)));
    vi.spyOn(console, "error").mockImplementation((line: unknown) => void err.push(String(line)));
    return { out, err };
  }

  it("installs name@marketplace from a local marketplace and prints provenance and the enable hint", async () => {
    process.env.SEEKFORGE_HOME = tempDir("seekforge-cli-plugin-home-");
    const market = tempDir("seekforge-cli-market-");
    fs.mkdirSync(path.join(market, ".claude-plugin"));
    fs.writeFileSync(
      path.join(market, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "team", plugins: [{ name: "demo", source: "./demo", description: "Demo plugin" }] }),
    );
    fs.mkdirSync(path.join(market, "demo"));
    fs.writeFileSync(
      path.join(market, "demo", "plugin.json"),
      JSON.stringify({ apiVersion: 1, id: "demo", name: "Demo", version: "1.0.0" }),
    );
    const { out, err } = captureOutput();

    await pluginMarketplaceAddCommand(market, {});
    pluginMarketplaceListCommand();
    await pluginInstallCommand("demo@team", false);
    pluginMarketplaceRemoveCommand("team");

    expect(err).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect(out).toContain(`added local marketplace team (${market})`);
    expect(out).toContain(`team\tlocal\t${market}`);
    expect(out).toContain("  demo\tDemo plugin");
    expect(out).toContain("installed plugin demo@1.0.0");
    expect(out).toContain(`source: demo@team via local ${path.join(market, "demo")}`);
    expect(out.some((line) => /^digest: sha256:[0-9a-f]{64}$/.test(line))).toBe(true);
    expect(out.some((line) => line.endsWith("run: seekforge plugin enable demo"))).toBe(true);
    expect(out).toContain("removed marketplace team");
  });

  it("reports an unusable source as a command failure", async () => {
    process.env.SEEKFORGE_HOME = tempDir("seekforge-cli-plugin-home-");
    const { err } = captureOutput();
    await pluginInstallCommand("http://example.com/plugin.tar.gz", false);
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toMatch(/unencrypted http/);
    process.exitCode = undefined;
    pluginMarketplaceListCommand();
    expect(process.exitCode).toBeUndefined();
  });
});
