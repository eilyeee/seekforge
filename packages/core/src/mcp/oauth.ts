import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isRecord } from "../util/guards.js";
import { McpError } from "./errors.js";
import { readLimitedResponseText } from "./http.js";

/**
 * Interactive OAuth 2.1 authorization for remote MCP servers: discovery,
 * PKCE, dynamic client registration, and the authorization-code exchange that
 * produces the refresh token the transport later renews on its own.
 *
 * Everything here is a network boundary. Metadata is server-controlled, so
 * every endpoint it names is re-validated before it is used — a discovery
 * document must not be able to redirect an authorization code or a client
 * secret to an arbitrary host.
 */

export type McpOAuthMetadata = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
};

export type McpOAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  /** Absolute expiry derived from `expires_in`, when the server sent one. */
  expiresAt?: string;
  scope?: string;
  tokenType: string;
};

export type McpOAuthClient = {
  clientId: string;
  clientSecret?: string;
};

/** Injection seam so tests drive discovery/exchange without a live server. */
export type McpOAuthFetch = (url: string, init?: RequestInit) => Promise<Response>;

const AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";
const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

/**
 * Only https is accepted, except on loopback, where the OAuth 2.1 native-app
 * guidance permits plain http for the redirect and for local test servers.
 */
export function assertSafeOAuthUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new McpError("mcp_auth_error", `MCP OAuth ${label} is missing`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpError("mcp_auth_error", `MCP OAuth ${label} is not an absolute URL`);
  }
  if (url.username || url.password) {
    throw new McpError("mcp_auth_error", `MCP OAuth ${label} must not embed credentials`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new McpError("mcp_auth_error", `MCP OAuth ${label} must use https`);
  }
  return url.toString();
}

function sameOrigin(left: string, right: string): boolean {
  return new URL(left).origin === new URL(right).origin;
}

function parseMetadata(document: unknown, discoveredFrom: string): McpOAuthMetadata {
  if (!isRecord(document)) {
    throw new McpError("mcp_auth_error", "MCP OAuth metadata is not an object");
  }
  const issuer = assertSafeOAuthUrl(document.issuer, "issuer");
  // RFC 8414: the issuer identifies the authorization server that published the
  // document. A mismatch means the document was served by somebody else.
  if (!sameOrigin(issuer, discoveredFrom)) {
    throw new McpError("mcp_auth_error", "MCP OAuth issuer does not match the discovery origin");
  }
  const authorizationEndpoint = assertSafeOAuthUrl(document.authorization_endpoint, "authorization_endpoint");
  const tokenEndpoint = assertSafeOAuthUrl(document.token_endpoint, "token_endpoint");
  const registrationEndpoint =
    document.registration_endpoint === undefined
      ? undefined
      : assertSafeOAuthUrl(document.registration_endpoint, "registration_endpoint");
  const methods = document.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) {
    throw new McpError("mcp_auth_error", "MCP OAuth server does not support PKCE S256");
  }
  const scopes = document.scopes_supported;
  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    ...(registrationEndpoint !== undefined ? { registrationEndpoint } : {}),
    ...(Array.isArray(scopes) && scopes.every((scope) => typeof scope === "string")
      ? { scopesSupported: scopes as string[] }
      : {}),
  };
}

async function fetchJson(fetchImpl: McpOAuthFetch, url: string, init: RequestInit, label: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new McpError(
      "mcp_auth_error",
      `MCP OAuth ${label} request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    const detail = await readLimitedResponseText(response).catch(() => "");
    throw new McpError(
      "mcp_auth_error",
      `MCP OAuth ${label} failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
  try {
    return JSON.parse(await readLimitedResponseText(response)) as unknown;
  } catch {
    throw new McpError("mcp_auth_error", `MCP OAuth ${label} returned invalid JSON`);
  }
}

/**
 * Resolves the authorization server for an MCP endpoint: the protected-resource
 * document names it when present, otherwise the server's own origin is used.
 */
export async function discoverMcpOAuthMetadata(
  serverUrl: string,
  options: { fetchImpl?: McpOAuthFetch; signal?: AbortSignal } = {},
): Promise<McpOAuthMetadata> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resource = new URL(assertSafeOAuthUrl(serverUrl, "server url"));
  const init: RequestInit = {
    headers: { accept: "application/json" },
    ...(options.signal ? { signal: options.signal } : {}),
  };

  let authorizationServer = resource.origin;
  const protectedResource = await fetchJson(
    fetchImpl,
    new URL(PROTECTED_RESOURCE_PATH, resource.origin).toString(),
    init,
    "protected-resource discovery",
  ).catch(() => undefined);
  if (isRecord(protectedResource) && Array.isArray(protectedResource.authorization_servers)) {
    const first = protectedResource.authorization_servers[0];
    authorizationServer = new URL(assertSafeOAuthUrl(first, "authorization server")).origin;
  }

  const document = await fetchJson(
    fetchImpl,
    new URL(AUTHORIZATION_SERVER_PATH, authorizationServer).toString(),
    init,
    "authorization-server discovery",
  );
  return parseMetadata(document, authorizationServer);
}

export type McpPkcePair = { verifier: string; challenge: string; method: "S256" };

/** RFC 7636 S256 pair; the verifier never leaves the process until the exchange. */
export function createMcpPkcePair(): McpPkcePair {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url"), method: "S256" };
}

export function createMcpOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time comparison so a callback cannot probe the state byte by byte. */
export function oauthStateMatches(expected: string, received: unknown): boolean {
  if (typeof received !== "string" || received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(received, "utf8"));
}

export function buildMcpAuthorizationUrl(
  metadata: McpOAuthMetadata,
  params: {
    clientId: string;
    redirectUri: string;
    state: string;
    challenge: string;
    scope?: string;
    resource?: string;
  },
): string {
  const url = new URL(metadata.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", assertSafeOAuthUrl(params.redirectUri, "redirect_uri"));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (params.scope) url.searchParams.set("scope", params.scope);
  // RFC 8707: binds the issued token to this MCP server, not to every resource.
  if (params.resource) url.searchParams.set("resource", assertSafeOAuthUrl(params.resource, "resource"));
  return url.toString();
}

/**
 * Parses the loopback callback. Returns the code only when the state matches,
 * so a cross-site redirect cannot inject somebody else's authorization code.
 */
export function readMcpOAuthCallback(requestUrl: string, expectedState: string): { code: string } {
  const url = new URL(requestUrl, "http://127.0.0.1");
  const error = url.searchParams.get("error");
  if (error) {
    const description = url.searchParams.get("error_description");
    throw new McpError(
      "mcp_auth_error",
      `MCP OAuth authorization denied: ${error}${description ? ` (${description})` : ""}`,
    );
  }
  if (!oauthStateMatches(expectedState, url.searchParams.get("state"))) {
    throw new McpError("mcp_auth_error", "MCP OAuth callback state did not match");
  }
  const code = url.searchParams.get("code");
  if (typeof code !== "string" || code.length === 0) {
    throw new McpError("mcp_auth_error", "MCP OAuth callback carried no authorization code");
  }
  return { code };
}

/** RFC 7591 dynamic registration, used only when no client id is configured. */
export async function registerMcpOAuthClient(
  metadata: McpOAuthMetadata,
  params: { redirectUri: string; clientName: string; scope?: string },
  options: { fetchImpl?: McpOAuthFetch; signal?: AbortSignal } = {},
): Promise<McpOAuthClient> {
  if (!metadata.registrationEndpoint) {
    throw new McpError(
      "mcp_auth_error",
      "MCP OAuth server supports neither a configured client id nor dynamic registration",
    );
  }
  const document = await fetchJson(
    options.fetchImpl ?? fetch,
    metadata.registrationEndpoint,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: params.clientName,
        redirect_uris: [assertSafeOAuthUrl(params.redirectUri, "redirect_uri")],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(params.scope ? { scope: params.scope } : {}),
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    },
    "dynamic client registration",
  );
  if (!isRecord(document) || typeof document.client_id !== "string" || document.client_id.length === 0) {
    throw new McpError("mcp_auth_error", "MCP OAuth registration omitted client_id");
  }
  return {
    clientId: document.client_id,
    ...(typeof document.client_secret === "string" && document.client_secret.length > 0
      ? { clientSecret: document.client_secret }
      : {}),
  };
}

function parseTokenResponse(document: unknown, label: string): McpOAuthTokens {
  if (!isRecord(document) || typeof document.access_token !== "string" || document.access_token.length === 0) {
    throw new McpError("mcp_auth_error", `MCP OAuth ${label} omitted access_token`);
  }
  const expiresIn = document.expires_in;
  return {
    accessToken: document.access_token,
    tokenType: typeof document.token_type === "string" ? document.token_type : "Bearer",
    ...(typeof document.refresh_token === "string" && document.refresh_token.length > 0
      ? { refreshToken: document.refresh_token }
      : {}),
    ...(typeof document.scope === "string" ? { scope: document.scope } : {}),
    ...(typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? { expiresAt: new Date(Date.now() + Math.floor(expiresIn) * 1000).toISOString() }
      : {}),
  };
}

export async function exchangeMcpAuthorizationCode(
  metadata: McpOAuthMetadata,
  params: {
    code: string;
    verifier: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    resource?: string;
  },
  options: { fetchImpl?: McpOAuthFetch; signal?: AbortSignal } = {},
): Promise<McpOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    code_verifier: params.verifier,
    client_id: params.clientId,
    redirect_uri: assertSafeOAuthUrl(params.redirectUri, "redirect_uri"),
    ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
    ...(params.resource ? { resource: assertSafeOAuthUrl(params.resource, "resource") } : {}),
  });
  const document = await fetchJson(
    options.fetchImpl ?? fetch,
    metadata.tokenEndpoint,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      ...(options.signal ? { signal: options.signal } : {}),
    },
    "token exchange",
  );
  return parseTokenResponse(document, "token exchange");
}
