import {
  createPluginScaffold,
  digestPluginDirectory,
  installPlugin,
  listPlugins,
  readPluginManifest,
  removePlugin,
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
    console.log(`${plugin.id}\t${plugin.manifest?.version ?? "-"}\t${plugin.scope}\t${plugin.status}`);
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
    const manifest = readPluginManifest(path);
    const digest = digestPluginDirectory(path);
    console.log(`valid plugin ${manifest.id}@${manifest.version} sha256:${digest}`);
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

export function pluginInstallCommand(path: string, force: boolean): void {
  try {
    const result = installPlugin(path, { force });
    console.log(`${result.updated ? "updated" : "installed"} plugin ${result.manifest.id}@${result.manifest.version}`);
    console.log(`disabled until reviewed; run: seekforge plugin enable ${result.manifest.id}`);
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
