import { z } from "zod";
import type { LspServerConfig } from "../../plugins/types.js";

/**
 * Configured language servers: the user's `lspServers` config key and the
 * `lspServers` a plugin contributes (Claude Code's `.lsp.json` shape included).
 *
 * A configured server REPLACES the built-in table's entry for every extension
 * it names. User config beats plugins; among plugins, the first enabled one
 * (by id) wins, and the loser is reported rather than silently merged.
 */

const EXTENSION_RE = /^\.[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;
const LANGUAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
export const LSP_SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const lspServerConfigSchema = z
  .object({
    command: z.string().trim().min(1).max(4_096),
    args: z.array(z.string().max(4_096)).max(64).optional(),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(8_192)).optional(),
    extensionToLanguage: z.record(z.string().regex(EXTENSION_RE), z.string().regex(LANGUAGE_ID_RE)).optional(),
    extensions: z.array(z.string().regex(EXTENSION_RE)).max(64).optional(),
    languageId: z.string().regex(LANGUAGE_ID_RE).optional(),
    initializationOptions: z.unknown().optional(),
    // Claude Code keys SeekForge reads but cannot honor differently.
    transport: z.literal("stdio").optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const mapped = Object.keys(value.extensionToLanguage ?? {}).length > 0;
    const listed = (value.extensions?.length ?? 0) > 0;
    if (!mapped && !listed) {
      ctx.addIssue({ code: "custom", message: "needs extensionToLanguage or extensions + languageId" });
    }
    if (listed && value.languageId === undefined) {
      ctx.addIssue({ code: "custom", message: "extensions needs a languageId" });
    }
  });

export const lspServersSchema = z.record(z.string().regex(LSP_SERVER_NAME_RE), lspServerConfigSchema);

/** Validate one server; returns the normalized config or an error message. */
export function parseLspServerConfig(raw: unknown): { config?: LspServerConfig; error?: string } {
  const parsed = lspServerConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: issue ? `${issue.path.join(".") || "server"}: ${issue.message}` : "invalid language server" };
  }
  const value = parsed.data;
  return {
    config: {
      command: value.command,
      ...(value.args ? { args: [...value.args] } : {}),
      ...(value.env ? { env: { ...value.env } } : {}),
      ...(value.extensionToLanguage ? { extensionToLanguage: { ...value.extensionToLanguage } } : {}),
      ...(value.extensions ? { extensions: [...value.extensions] } : {}),
      ...(value.languageId !== undefined ? { languageId: value.languageId } : {}),
      ...(value.initializationOptions !== undefined ? { initializationOptions: value.initializationOptions } : {}),
    },
  };
}

/** `.ext` (lower-cased) → languageId pairs one server serves. */
export function lspServerExtensions(config: LspServerConfig): Array<[string, string]> {
  const pairs = new Map<string, string>();
  for (const [ext, languageId] of Object.entries(config.extensionToLanguage ?? {}))
    pairs.set(ext.toLowerCase(), languageId);
  if (config.languageId !== undefined) {
    for (const ext of config.extensions ?? []) pairs.set(ext.toLowerCase(), config.languageId);
  }
  return [...pairs];
}

export type ConfiguredLspServer = { name: string; source: "user" | "plugin"; config: LspServerConfig };

/**
 * Merge plugin-contributed and user-configured servers into one extension
 * table. Invalid user entries are reported, never thrown: a typo in one
 * server must not take every other language server down with it.
 */
export function resolveLspServerTable(
  plugin: Record<string, LspServerConfig> | undefined,
  user: Record<string, unknown> | undefined,
): { byExtension: Map<string, ConfiguredLspServer & { languageId: string }>; warnings: string[] } {
  const byExtension = new Map<string, ConfiguredLspServer & { languageId: string }>();
  const warnings: string[] = [];
  const add = (entry: ConfiguredLspServer, override: boolean): void => {
    for (const [ext, languageId] of lspServerExtensions(entry.config)) {
      const existing = byExtension.get(ext);
      if (existing && !override) {
        warnings.push(`language server ${entry.name} for ${ext} is shadowed by ${existing.name}`);
        continue;
      }
      byExtension.set(ext, { ...entry, languageId });
    }
  };
  for (const name of Object.keys(plugin ?? {}).sort()) {
    add({ name, source: "plugin", config: plugin![name]! }, false);
  }
  for (const [name, raw] of Object.entries(user ?? {})) {
    if (!LSP_SERVER_NAME_RE.test(name)) {
      warnings.push(`lspServers: invalid server name "${name}"`);
      continue;
    }
    const parsed = parseLspServerConfig(raw);
    if (!parsed.config) {
      warnings.push(`lspServers.${name}: ${parsed.error}`);
      continue;
    }
    add({ name, source: "user", config: parsed.config }, true);
  }
  return { byExtension, warnings };
}
