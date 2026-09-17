import { isRecord } from "../util/guards.js";
import { scrubSecretEnv } from "../util/scrub-env.js";
import { McpError } from "./errors.js";
import type { McpServerConfig, McpServerTrust, McpTransportKind } from "./types.js";

/**
 * What a server definition may reach on this machine, decided in one place.
 *
 * A definition names a process to start or an endpoint to contact, and `${VAR}`
 * references let it pull values out of the environment into that command line,
 * that URL, those headers. For a definition the user wrote that is the point —
 * secrets stay out of committed config. For one a checkout wrote it is a way
 * to post the user's tokens to wherever the checkout likes. So:
 *
 * - `user`: references expand; a stdio child inherits the whole environment
 *   (what Claude Code does, and what every existing user entry relies on).
 * - `project` (approved): references expand — the user approved the template
 *   with the references visible — but a stdio child inherits the environment
 *   with secret-looking variables removed, except the ones the entry's own
 *   `env` names, which the user saw.
 * - `untrusted`: nothing expands, and the child gets the scrubbed environment.
 *   Only an explicit management action connects such an entry at all.
 */

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Expands `${VAR}` and `${VAR:-default}`. As in a shell, the default applies
 * when the variable is unset or empty; a missing variable without a default
 * becomes the empty string. The default itself is taken literally.
 */
export function expandMcpEnvRefs(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(ENV_REF, (_match, name: string, fallback: string | undefined) => {
    const current = env[name];
    if (current !== undefined && current !== "") return current;
    return fallback ?? "";
  });
}

/** Whether a definition's `${VAR}` references are expanded at all. */
export function mcpExpandsEnv(trust: McpServerTrust): boolean {
  return trust !== "untrusted";
}

/** The transport a definition selects: explicit `type`, else `url` → http, else stdio. */
export function mcpTransportOf(config: McpServerConfig): McpTransportKind {
  const type = (config as { type?: unknown }).type;
  if (type === "stdio" || type === "http" || type === "sse") return type;
  if (type !== undefined) {
    throw new McpError("mcp_config", `unsupported MCP transport type ${JSON.stringify(type)}`);
  }
  return config.url ? "http" : "stdio";
}

function expandRecord(
  values: Record<string, string> | undefined,
  expand: (value: string) => string,
): Record<string, string> | undefined {
  if (!isRecord(values)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string") out[key] = expand(value);
  }
  return out;
}

/**
 * The definition as it will actually be used: references expanded when the
 * trust allows it, left literal otherwise. `oauth` values expand under the same
 * rule. The input is never mutated — the unexpanded form is what approvals
 * are recorded against and what a prompt shows.
 */
export function resolveMcpServerConfig(
  config: McpServerConfig,
  trust: McpServerTrust,
  env: NodeJS.ProcessEnv = process.env,
): McpServerConfig {
  if (!mcpExpandsEnv(trust)) return config;
  const expand = (value: string): string => expandMcpEnvRefs(value, env);
  const envValues = expandRecord(config.env, expand);
  const headers = expandRecord(config.headers, expand);
  return {
    ...config,
    ...(typeof config.command === "string" ? { command: expand(config.command) } : {}),
    ...(Array.isArray(config.args)
      ? { args: config.args.map((arg) => (typeof arg === "string" ? expand(arg) : arg)) }
      : {}),
    ...(envValues !== undefined ? { env: envValues } : {}),
    ...(typeof config.url === "string" ? { url: expand(config.url) } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(config.oauth
      ? {
          oauth: {
            tokenEndpoint: expand(config.oauth.tokenEndpoint),
            clientId: expand(config.oauth.clientId),
            ...(config.oauth.clientSecret !== undefined ? { clientSecret: expand(config.oauth.clientSecret) } : {}),
            refreshToken: expand(config.oauth.refreshToken),
            ...(config.oauth.scope !== undefined ? { scope: expand(config.oauth.scope) } : {}),
          },
        }
      : {}),
  };
}

/**
 * The environment a stdio child starts with. `resolved` is the output of
 * {@link resolveMcpServerConfig}, so its `env` values are already expanded (or
 * deliberately literal).
 */
export function mcpChildEnv(
  resolved: McpServerConfig,
  trust: McpServerTrust,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const inherited = trust === "user" ? { ...source } : scrubSecretEnv(source);
  return { ...inherited, ...(expandRecord(resolved.env, (value) => value) ?? {}) };
}

/**
 * The trust a caller that does not say otherwise gets: `trusted: true` can only
 * survive in a user-owned layer (a repository layer has it stripped), and every
 * other entry is treated as nobody's.
 */
export function defaultMcpServerTrust(config: McpServerConfig): McpServerTrust {
  return config.trusted === true ? "user" : "untrusted";
}
