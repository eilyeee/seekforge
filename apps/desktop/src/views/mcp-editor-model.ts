import type { McpPermission, McpScope } from "../types";

export type KeyValueRow = { key: string; value: string };

export type McpServerDraft = {
  name: string;
  scope: McpScope;
  trusted: boolean;
  permission?: McpPermission | null;
  toolPermissions?: Record<string, McpPermission>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  oauth?: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
    scope?: string;
  };
};

export function rowsOf(values: Record<string, string>): KeyValueRow[] {
  return Object.entries(values).map(([key, value]) => ({ key, value }));
}

export function recordOf(rows: KeyValueRow[]): Record<string, string> | null {
  const values: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (values[key] !== undefined) return null;
    values[key] = row.value;
  }
  return values;
}

export function buildMcpServerDraft(input: {
  name: string;
  scope: McpScope;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  oauthEnabled: boolean;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  oauthScope: string;
  trusted: boolean;
  permission?: McpPermission | null;
  toolPermissions: Record<string, McpPermission>;
}): McpServerDraft {
  if (input.transport === "stdio") {
    return {
      name: input.name.trim(),
      scope: input.scope,
      command: input.command.trim(),
      args: input.args,
      env: input.env,
      trusted: input.trusted,
      ...(input.permission !== undefined ? { permission: input.permission } : {}),
      toolPermissions: input.toolPermissions,
    };
  }
  return {
    name: input.name.trim(),
    scope: input.scope,
    url: input.url.trim(),
    headers: input.headers,
    ...(input.oauthEnabled
      ? {
          oauth: {
            tokenEndpoint: input.tokenEndpoint.trim(),
            clientId: input.clientId.trim(),
            refreshToken: input.refreshToken,
            ...(input.clientSecret !== "" ? { clientSecret: input.clientSecret } : {}),
            ...(input.oauthScope.trim() !== "" ? { scope: input.oauthScope.trim() } : {}),
          },
        }
      : {}),
    trusted: input.trusted,
    ...(input.permission !== undefined ? { permission: input.permission } : {}),
    toolPermissions: input.toolPermissions,
  };
}
