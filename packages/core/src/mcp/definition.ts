import { PERMISSION_LEVEL, type PermissionName } from "@seekforge/shared";
import { isRecord } from "../util/guards.js";
import type { McpServerConfig } from "./types.js";

/**
 * Validation for an MCP server definition someone is about to store: typed on
 * the command line, pasted as JSON, or imported from another tool's config.
 * The loader stays tolerant of whatever is already on disk; this is the gate
 * in front of writing a new entry.
 */

const KNOWN_FIELDS = [
  "type",
  "command",
  "args",
  "env",
  "url",
  "headers",
  "oauth",
  "trusted",
  "permission",
  "toolPermissions",
] as const;

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** RFC 9110 token characters. */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_SERVER_NAME_CHARS = 128;

export class McpDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpDefinitionError";
  }
}

function isPermission(value: unknown): value is PermissionName {
  return typeof value === "string" && Object.hasOwn(PERMISSION_LEVEL, value);
}

function stringRecord(value: unknown, field: string, keyRule?: { re: RegExp; what: string }): Record<string, string> {
  if (!isRecord(value)) throw new McpDefinitionError(`${field} must be an object with string values`);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new McpDefinitionError(`${field}.${key} must be a string`);
    if (keyRule && !keyRule.re.test(key))
      throw new McpDefinitionError(`${field}: ${JSON.stringify(key)} is not a valid ${keyRule.what}`);
    out[key] = item;
  }
  return out;
}

/** A server name usable as a config key and inside tool names. */
export function validateMcpServerName(name: string): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.length === 0) throw new McpDefinitionError("server name must not be empty");
  if (trimmed.length > MAX_SERVER_NAME_CHARS) {
    throw new McpDefinitionError(`server name must be at most ${MAX_SERVER_NAME_CHARS} characters`);
  }
  if ([...trimmed].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) {
    throw new McpDefinitionError("server name must not contain control characters");
  }
  return trimmed;
}

/**
 * `true` when `url` is an absolute http(s) URL — or a `${VAR}` template, which
 * cannot be checked until it expands.
 */
function acceptableUrl(url: string): boolean {
  if (url.includes("${")) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Parses one definition. `unknownFields: "reject"` (default) refuses fields
 * this format does not define; `"drop"` removes them and reports which — for
 * importing another tool's config, which carries its own extras.
 */
export function parseMcpServerDefinition(
  value: unknown,
  options: { unknownFields?: "reject" | "drop" } = {},
): { config: McpServerConfig; dropped: string[] } {
  if (!isRecord(value)) throw new McpDefinitionError("a server definition must be a JSON object");
  const dropped = Object.keys(value).filter((key) => !(KNOWN_FIELDS as readonly string[]).includes(key));
  if (dropped.length > 0 && options.unknownFields !== "drop") {
    throw new McpDefinitionError(`unsupported field(s): ${dropped.join(", ")}`);
  }
  const { type, command, args, env, url, headers, oauth, trusted, permission, toolPermissions } = value;

  if (type !== undefined && type !== "stdio" && type !== "http" && type !== "sse") {
    throw new McpDefinitionError('type must be "stdio", "http" or "sse"');
  }
  if (command !== undefined && typeof command !== "string") throw new McpDefinitionError("command must be a string");
  if (args !== undefined && !(Array.isArray(args) && args.every((arg) => typeof arg === "string"))) {
    throw new McpDefinitionError("args must be an array of strings");
  }
  if (url !== undefined && typeof url !== "string") throw new McpDefinitionError("url must be a string");
  if (trusted !== undefined && typeof trusted !== "boolean") throw new McpDefinitionError("trusted must be a boolean");
  if (permission !== undefined && !isPermission(permission)) {
    throw new McpDefinitionError("permission must be readonly, write, execute, env or dangerous");
  }
  let tools: Record<string, PermissionName> | undefined;
  if (toolPermissions !== undefined) {
    if (!isRecord(toolPermissions)) throw new McpDefinitionError("toolPermissions must be an object");
    tools = {};
    for (const [tool, level] of Object.entries(toolPermissions)) {
      if (tool.length === 0 || tool.length > 256 || !isPermission(level)) {
        throw new McpDefinitionError("toolPermissions must map tool names to valid permissions");
      }
      tools[tool] = level;
    }
  }

  const hasCommand = typeof command === "string" && command.trim() !== "";
  const hasUrl = typeof url === "string" && url.trim() !== "";
  // Other tools write empty `args: []` / `env: {}` / `headers: {}` freely; only content counts.
  const present = (field: unknown): boolean =>
    Array.isArray(field) ? field.length > 0 : isRecord(field) ? Object.keys(field).length > 0 : field !== undefined;
  const transport = type ?? (hasUrl ? "http" : "stdio");
  if (transport === "stdio") {
    if (!hasCommand) throw new McpDefinitionError("a stdio server needs a command");
    if (hasUrl) throw new McpDefinitionError("a stdio server takes a command, not a url");
    if (present(headers) || oauth !== undefined) {
      throw new McpDefinitionError("headers and oauth apply only to http and sse servers");
    }
  } else {
    if (!hasUrl) throw new McpDefinitionError(`an ${transport} server needs a url`);
    if (hasCommand || present(args) || present(env)) {
      throw new McpDefinitionError(`an ${transport} server takes a url, not command/args/env`);
    }
    if (!acceptableUrl((url as string).trim())) {
      throw new McpDefinitionError("url must be an absolute http or https URL");
    }
  }

  let oauthConfig: McpServerConfig["oauth"];
  if (oauth !== undefined) {
    if (!isRecord(oauth)) throw new McpDefinitionError("oauth must be an object");
    const { tokenEndpoint, clientId, clientSecret, refreshToken, scope } = oauth;
    if (
      typeof tokenEndpoint !== "string" ||
      tokenEndpoint.trim() === "" ||
      typeof clientId !== "string" ||
      clientId.trim() === "" ||
      typeof refreshToken !== "string" ||
      refreshToken === "" ||
      (clientSecret !== undefined && typeof clientSecret !== "string") ||
      (scope !== undefined && typeof scope !== "string")
    ) {
      throw new McpDefinitionError(
        "oauth needs tokenEndpoint, clientId and refreshToken strings; clientSecret and scope are optional strings",
      );
    }
    oauthConfig = {
      tokenEndpoint,
      clientId,
      refreshToken,
      ...(clientSecret !== undefined ? { clientSecret } : {}),
      ...(scope !== undefined ? { scope } : {}),
    };
  }

  const envValues =
    env === undefined ? undefined : stringRecord(env, "env", { re: ENV_NAME_RE, what: "variable name" });
  const headerValues =
    headers === undefined ? undefined : stringRecord(headers, "headers", { re: HEADER_NAME_RE, what: "header name" });
  const stdio = transport === "stdio";
  const config: McpServerConfig = {
    ...(type !== undefined ? { type } : {}),
    ...(hasCommand ? { command: (command as string).trim() } : {}),
    ...(stdio && Array.isArray(args) && args.length > 0 ? { args: [...(args as string[])] } : {}),
    ...(stdio && envValues && Object.keys(envValues).length > 0 ? { env: envValues } : {}),
    ...(hasUrl ? { url: (url as string).trim() } : {}),
    ...(!stdio && headerValues && Object.keys(headerValues).length > 0 ? { headers: headerValues } : {}),
    ...(oauthConfig ? { oauth: oauthConfig } : {}),
    ...(trusted !== undefined ? { trusted } : {}),
    ...(permission !== undefined ? { permission } : {}),
    ...(tools && Object.keys(tools).length > 0 ? { toolPermissions: tools } : {}),
  };
  return { config, dropped };
}

/** `KEY=VALUE` → [key, value]; the value may itself contain `=`. */
export function parseMcpEnvAssignment(text: string): [string, string] {
  const at = text.indexOf("=");
  const key = at > 0 ? text.slice(0, at).trim() : "";
  if (!ENV_NAME_RE.test(key)) throw new McpDefinitionError(`--env expects KEY=VALUE, got ${JSON.stringify(text)}`);
  return [key, text.slice(at + 1)];
}

/** `Name: value` (or `Name=value`) → [name, value], as curl's -H spells it. */
export function parseMcpHeaderAssignment(text: string): [string, string] {
  const separators = [text.indexOf(":"), text.indexOf("=")].filter((index) => index > 0);
  const at = separators.length > 0 ? Math.min(...separators) : -1;
  const name = at > 0 ? text.slice(0, at).trim() : "";
  if (!HEADER_NAME_RE.test(name))
    throw new McpDefinitionError(`--header expects "Name: value", got ${JSON.stringify(text)}`);
  return [name, text.slice(at + 1).trim()];
}
