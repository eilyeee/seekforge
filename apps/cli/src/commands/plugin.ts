import {
  addMarketplace,
  createPluginScaffold,
  describePluginOrigin,
  digestPluginDirectory,
  installPluginFromSource,
  listMarketplaces,
  listPlugins,
  pluginSupplyChainReport,
  readPluginManifestDetailed,
  removeMarketplace,
  removePlugin,
  rollbackPlugin,
  setPluginEnabled,
} from "@seekforge/core";

function fail(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

export function pluginListCommand(json = false): void {
  const plugins = listPlugins(process.cwd());
  if (json) {
    console.log(JSON.stringify(plugins, null, 2));
    return;
  }
  if (plugins.length === 0) {
    console.log("no plugins found");
    return;
  }
  for (const plugin of plugins) {
    const format = plugin.format === "claude" ? "\tclaude-code" : "";
    console.log(`${plugin.id}\t${plugin.manifest?.version ?? "-"}\t${plugin.scope}\t${plugin.status}${format}`);
    for (const warning of plugin.warnings ?? []) console.log(`  warning: ${warning}`);
  }
}

export function pluginInspectCommand(id: string, json = false): void {
  const plugin = listPlugins(process.cwd()).find((record) => record.id === id);
  if (!plugin) {
    fail(new Error(`plugin ${id} not found`));
    return;
  }
  console.log(json ? JSON.stringify(plugin, null, 2) : JSON.stringify(plugin.manifest ?? plugin, null, 2));
}

export function pluginValidateCommand(path: string): void {
  try {
    const { manifest, format, warnings } = readPluginManifestDetailed(path);
    const digest = digestPluginDirectory(path);
    console.log(
      `valid ${format === "claude" ? "Claude Code " : ""}plugin ${manifest.id}@${manifest.version} sha256:${digest}`,
    );
    for (const warning of warnings) console.error(`warning: ${warning}`);
  } catch (error) {
    fail(error);
  }
}

export function pluginCreateCommand(id: string): void {
  try {
    const result = createPluginScaffold(process.cwd(), id);
    console.log(`created plugin scaffold at ${result.path}`);
  } catch (error) {
    fail(error);
  }
}

/** `source`: a local directory, git URL (optionally `#ref`), https archive, or `<plugin>@<marketplace>`. */
export async function pluginInstallCommand(source: string, force: boolean): Promise<void> {
  try {
    const result = await installPluginFromSource(source, { force });
    console.log(`${result.updated ? "updated" : "installed"} plugin ${result.manifest.id}@${result.manifest.version}`);
    console.log(`source: ${describePluginOrigin(result.origin)}`);
    console.log(`digest: sha256:${result.digest}`);
    console.log(`disabled until reviewed (${result.path}); run: seekforge plugin enable ${result.manifest.id}`);
  } catch (error) {
    fail(error);
  }
}

export async function pluginMarketplaceAddCommand(
  source: string,
  opts: { name?: string; force?: boolean },
): Promise<void> {
  try {
    const added = await addMarketplace(source, {
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      force: opts.force === true,
    });
    const pinned = added.commit ? ` @ ${added.commit}` : "";
    console.log(`added ${added.kind} marketplace ${added.name} (${added.source}${pinned})`);
    console.log(
      `${added.plugins?.length ?? 0} plugin(s); install one with: seekforge plugin install <name>@${added.name}`,
    );
    for (const issue of added.issues ?? []) console.error(`warning: ${issue}`);
  } catch (error) {
    fail(error);
  }
}

export function pluginMarketplaceRemoveCommand(name: string): void {
  try {
    const result = removeMarketplace(name);
    console.log(`removed marketplace ${result.name}${result.removedCache ? " and its cached copy" : ""}`);
  } catch (error) {
    fail(error);
  }
}

export function pluginMarketplaceListCommand(json = false): void {
  try {
    const marketplaces = listMarketplaces();
    if (json) {
      console.log(JSON.stringify(marketplaces, null, 2));
      return;
    }
    if (marketplaces.length === 0) {
      console.log("no marketplaces; add one with: seekforge plugin marketplace add <git-url|path>");
      return;
    }
    for (const market of marketplaces) {
      const pinned = market.commit ? `@${market.commit.slice(0, 12)}` : "";
      console.log(`${market.name}\t${market.kind}\t${market.source}${pinned}`);
      if (market.error) {
        console.log(`  error: ${market.error}`);
        continue;
      }
      for (const plugin of market.plugins ?? []) {
        const version = plugin.version ? `@${plugin.version}` : "";
        console.log(`  ${plugin.name}${version}${plugin.description ? `\t${plugin.description}` : ""}`);
      }
      for (const issue of market.issues ?? []) console.log(`  skipped: ${issue}`);
    }
  } catch (error) {
    fail(error);
  }
}

export function pluginRollbackCommand(id: string): void {
  try {
    const result = rollbackPlugin(id);
    console.log(`rolled back plugin ${result.manifest.id} to ${result.manifest.version}`);
    console.log(`disabled until reviewed; run: seekforge plugin enable ${result.manifest.id}`);
  } catch (error) {
    fail(error);
  }
}

export function pluginSupplyChainCommand(json = false): void {
  try {
    const report = pluginSupplyChainReport(process.cwd());
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (report.entries.length === 0) {
      console.log("no plugins found");
      return;
    }
    for (const entry of report.entries) {
      console.log(
        [
          entry.id,
          entry.version ?? "-",
          entry.scope,
          entry.status,
          entry.integrity,
          entry.rollbackAvailable ? "rollback" : "no-rollback",
          entry.compatibility.compatible ? "compatible" : "incompatible",
          entry.capabilities.join(",") || "-",
        ].join("\t"),
      );
    }
  } catch (error) {
    fail(error);
  }
}

export function pluginSetEnabledCommand(id: string, enabled: boolean): void {
  try {
    setPluginEnabled(id, enabled);
    console.log(`${enabled ? "enabled" : "disabled"} plugin ${id}`);
  } catch (error) {
    fail(error);
  }
}

export function pluginRemoveCommand(id: string): void {
  try {
    const result = removePlugin(id);
    console.log(`removed plugin ${result.id} from ${result.removed}`);
  } catch (error) {
    fail(error);
  }
}
