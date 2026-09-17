export {
  digestPluginDirectory,
  globalPluginsRoot,
  listPlugins,
  loadPluginContributions,
  mergePluginHooks,
  mergePluginLspServers,
  mergePluginMcpServers,
  pluginSupplyChainReport,
  PLUGIN_ID_RE,
  projectPluginsRoot,
  readPluginManifest,
  readPluginManifestDetailed,
} from "./load.js";
export { translateClaudePlugin, type ClaudePluginTranslation } from "./claude.js";
export { createPluginScaffold, installPlugin, removePlugin, rollbackPlugin, setPluginEnabled } from "./manage.js";
export {
  describePluginOrigin,
  installPluginFromSource,
  type InstallFromSourceOptions,
  type InstallFromSourceResult,
} from "./remote.js";
export {
  addMarketplace,
  listMarketplaces,
  readMarketplaceManifest,
  removeMarketplace,
  resolveMarketplacePlugin,
  type AddMarketplaceOptions,
  type MarketplaceEntrySource,
  type MarketplaceListing,
  type MarketplaceManifest,
  type MarketplacePluginEntry,
  type MarketplaceRecord,
  type ResolvedMarketplacePlugin,
} from "./marketplace.js";
export { classifyPluginSource, type PluginSourceSpec } from "./source.js";
export { PLUGIN_API_VERSION } from "./types.js";
export type {
  LspServerConfig,
  PluginCommandRoot,
  PluginContributions,
  PluginFormat,
  PluginManifest,
  PluginOrigin,
  PluginRecord,
  PluginScope,
  PluginStatus,
} from "./types.js";
export type { PluginSupplyChainEntry } from "@seekforge/shared";
