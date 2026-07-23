import type { PluginRecord } from "@seekforge/core";

function collapse(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Compact /plugins listing; mutations stay in the explicit CLI/Desktop review flows. */
export function formatPluginLines(plugins: readonly PluginRecord[]): string[] {
  if (plugins.length === 0) return ["no plugins found — seekforge plugin create <id> scaffolds one"];
  return plugins.map((plugin) => {
    const version = plugin.manifest?.version ? `@${plugin.manifest.version}` : "";
    const description = plugin.manifest?.description ? `  ${collapse(plugin.manifest.description, 60)}` : "";
    const error = plugin.error ? `  ${collapse(plugin.error, 80)}` : "";
    return `${plugin.id}${version}  (${plugin.scope})  [${plugin.status}]${description}${error}`;
  });
}
