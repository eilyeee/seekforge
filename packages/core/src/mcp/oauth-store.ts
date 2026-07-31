import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireSessionLease } from "../agent/session-lease.js";
import { seekforgeHome } from "../memory/store.js";
import { readFileIfExists, writeFileAtomic } from "../util/fs.js";
import { hasOnlyKeys, isRecord } from "../util/guards.js";
import type { McpOAuthTokens } from "./oauth.js";

/**
 * Storage for interactively obtained MCP OAuth credentials.
 *
 * These are long-lived secrets, so they are deliberately NOT written back into
 * `.seekforge/config.json`: config is routinely committed, shared, and printed.
 * They live in one owner-only file under the SeekForge home instead, keyed by
 * server name *and* endpoint so pointing a name at a new URL cannot silently
 * reuse the old server's token.
 */

export type McpOAuthCredential = {
  serverName: string;
  /** Endpoint the credential was issued for; a URL change invalidates it. */
  serverUrl: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: string;
  scope?: string;
  updatedAt: string;
};

type CredentialFile = { version: 1; credentials: McpOAuthCredential[] };

const MAX_CREDENTIALS = 64;
const MAX_STORE_BYTES = 256 * 1024;
const MAX_SECRET_CHARS = 16 * 1024;
const FILE_MODE = 0o600;

export function mcpOAuthStorePath(): string {
  return join(seekforgeHome(), ".seekforge", "mcp-oauth.json");
}

function credentialKey(serverName: string, serverUrl: string): string {
  return `${serverName}\0${serverUrl}`;
}

function parseCredential(value: unknown): McpOAuthCredential | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "serverName",
      "serverUrl",
      "tokenEndpoint",
      "clientId",
      "clientSecret",
      "refreshToken",
      "accessToken",
      "expiresAt",
      "scope",
      "updatedAt",
    ])
  )
    return null;
  const required = ["serverName", "serverUrl", "tokenEndpoint", "clientId", "updatedAt"] as const;
  for (const key of required) {
    if (
      typeof value[key] !== "string" ||
      (value[key] as string).length === 0 ||
      (value[key] as string).length > MAX_SECRET_CHARS
    )
      return null;
  }
  const optional = ["clientSecret", "refreshToken", "accessToken", "expiresAt", "scope"] as const;
  for (const key of optional) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "string" || (value[key] as string).length > MAX_SECRET_CHARS)
    )
      return null;
  }
  if (!Number.isFinite(Date.parse(value.updatedAt as string))) return null;
  if (value.expiresAt !== undefined && !Number.isFinite(Date.parse(value.expiresAt as string))) return null;
  try {
    for (const key of ["serverUrl", "tokenEndpoint"] as const) {
      const url = new URL(value[key] as string);
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    }
  } catch {
    return null;
  }
  return value as unknown as McpOAuthCredential;
}

function readStore(): CredentialFile {
  const path = mcpOAuthStorePath();
  const raw = readFileIfExists(path, MAX_STORE_BYTES);
  if (raw === undefined) return { version: 1, credentials: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // A corrupt store must not block a fresh login; it is replaced on write.
    return { version: 1, credentials: [] };
  }
  if (
    !isRecord(parsed) ||
    !hasOnlyKeys(parsed, ["version", "credentials"]) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.credentials) ||
    parsed.credentials.length > MAX_CREDENTIALS
  ) {
    return { version: 1, credentials: [] };
  }
  const credentials: McpOAuthCredential[] = [];
  for (const entry of parsed.credentials) {
    const credential = parseCredential(entry);
    if (credential) credentials.push(credential);
  }
  return { version: 1, credentials };
}

function writeStore(file: CredentialFile): void {
  const path = mcpOAuthStorePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
  // writeFileAtomic renames a fresh temp file into place, so the mode is
  // reapplied after every write rather than only at creation.
  chmodSync(path, FILE_MODE);
}

export function listMcpOAuthCredentials(): McpOAuthCredential[] {
  return readStore().credentials;
}

export function readMcpOAuthCredential(serverName: string, serverUrl: string): McpOAuthCredential | undefined {
  const wanted = credentialKey(serverName, serverUrl);
  return readStore().credentials.find(
    (credential) => credentialKey(credential.serverName, credential.serverUrl) === wanted,
  );
}

/** Upserts a credential, keeping the previous refresh token when none is reissued. */
export function saveMcpOAuthCredential(
  input: Omit<McpOAuthCredential, "updatedAt"> & { updatedAt?: string },
): McpOAuthCredential {
  const lease = acquireSessionLease(seekforgeHome(), "mcp-oauth-credentials");
  try {
    const file = readStore();
    const key = credentialKey(input.serverName, input.serverUrl);
    const index = file.credentials.findIndex(
      (credential) => credentialKey(credential.serverName, credential.serverUrl) === key,
    );
    const previous = index >= 0 ? file.credentials[index] : undefined;
    const next: McpOAuthCredential = {
      ...input,
      // Rotation is optional in OAuth: an omitted refresh_token means "keep using
      // the one you have", so dropping it here would silently break renewal.
      ...(input.refreshToken === undefined && previous?.refreshToken !== undefined
        ? { refreshToken: previous.refreshToken }
        : {}),
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    };
    if (!parseCredential(next)) throw new Error("MCP OAuth credential is invalid");
    if (index >= 0) file.credentials[index] = next;
    else file.credentials.push(next);
    if (file.credentials.length > MAX_CREDENTIALS) {
      file.credentials = file.credentials
        .slice()
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, MAX_CREDENTIALS);
    }
    writeStore(file);
    return next;
  } finally {
    lease.release();
  }
}

/** Records the tokens from a login or refresh against an existing client. */
export function recordMcpOAuthTokens(
  identity: { serverName: string; serverUrl: string; tokenEndpoint: string; clientId: string; clientSecret?: string },
  tokens: McpOAuthTokens,
): McpOAuthCredential {
  return saveMcpOAuthCredential({
    ...identity,
    ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
    accessToken: tokens.accessToken,
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
    ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
  });
}

/** Returns true when a credential was removed. */
export function deleteMcpOAuthCredential(serverName: string, serverUrl?: string): boolean {
  const lease = acquireSessionLease(seekforgeHome(), "mcp-oauth-credentials");
  try {
    const file = readStore();
    const remaining = file.credentials.filter((credential) =>
      serverUrl === undefined
        ? credential.serverName !== serverName
        : credentialKey(credential.serverName, credential.serverUrl) !== credentialKey(serverName, serverUrl),
    );
    if (remaining.length === file.credentials.length) return false;
    writeStore({ version: 1, credentials: remaining });
    return true;
  } finally {
    lease.release();
  }
}
