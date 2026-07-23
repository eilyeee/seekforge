export {
  digestPluginDirectory,
  globalPluginsRoot,
  listPlugins,
  loadPluginContributions,
  mergePluginHooks,
  mergePluginMcpServers,
  PLUGIN_ID_RE,
  projectPluginsRoot,
  readPluginManifest,
} from "./load.js";
export { createPluginScaffold, installPlugin, removePlugin, setPluginEnabled } from "./manage.js";
export { PLUGIN_API_VERSION } from "./types.js";
export type {
  PluginContributions,
  PluginManifest,
  PluginRecord,
  PluginScope,
  PluginStatus,
} from "./types.js";
