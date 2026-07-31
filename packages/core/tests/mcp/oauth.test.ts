import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMcpAuthorizationUrl,
  createMcpPkcePair,
  discoverMcpOAuthMetadata,
  exchangeMcpAuthorizationCode,
  type McpOAuthMetadata,
  readMcpOAuthCallback,
  registerMcpOAuthClient,
} from "../../src/mcp/oauth.js";
import {
  deleteMcpOAuthCredential,
  listMcpOAuthCredentials,
  mcpOAuthStorePath,
  readMcpOAuthCredential,
  recordMcpOAuthTokens,
  saveMcpOAuthCredential,
} from "../../src/mcp/oauth-store.js";

const METADATA: McpOAuthMetadata = {
  issuer: "https://auth.example.com/",
  authorizationEndpoint: "https://auth.example.com/authorize",
  tokenEndpoint: "https://auth.example.com/token",
  registrationEndpoint: "https://auth.example.com/register",
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("MCP OAuth discovery", () => {
  it("resolves the authorization server named by the protected resource", async () => {
    const requested: string[] = [];
    const metadata = await discoverMcpOAuthMetadata("https://mcp.example.com/mcp", {
      fetchImpl: async (url) => {
        requested.push(url);
        if (url.endsWith("/.well-known/oauth-protected-resource")) {
          return json({ authorization_servers: ["https://auth.example.com"] });
        }
        return json({
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["mcp:read"],
        });
      },
    });

    expect(requested).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource",
      "https://auth.example.com/.well-known/oauth-authorization-server",
    ]);
    expect(metadata).toMatchObject({
      tokenEndpoint: "https://auth.example.com/token",
      scopesSupported: ["mcp:read"],
    });
  });

  it("falls back to the MCP server's own origin when there is no resource document", async () => {
    const metadata = await discoverMcpOAuthMetadata("https://mcp.example.com/mcp", {
      fetchImpl: async (url) => {
        if (url.endsWith("/.well-known/oauth-protected-resource")) return json({ error: "not found" }, 404);
        return json({
          issuer: "https://mcp.example.com",
          authorization_endpoint: "https://mcp.example.com/authorize",
          token_endpoint: "https://mcp.example.com/token",
        });
      },
    });
    expect(metadata.issuer).toBe("https://mcp.example.com/");
  });

  it("rejects metadata that redirects the flow off the issuer or onto plain http", async () => {
    const discover = (document: Record<string, unknown>) =>
      discoverMcpOAuthMetadata("https://mcp.example.com/mcp", {
        fetchImpl: async (url) =>
          url.endsWith("/.well-known/oauth-protected-resource") ? json({}, 404) : json(document),
      });

    await expect(
      discover({
        issuer: "https://evil.example.net",
        authorization_endpoint: "https://evil.example.net/authorize",
        token_endpoint: "https://evil.example.net/token",
      }),
    ).rejects.toThrow(/issuer does not match/);
    await expect(
      discover({
        issuer: "https://mcp.example.com",
        authorization_endpoint: "https://mcp.example.com/authorize",
        token_endpoint: "http://mcp.example.com/token",
      }),
    ).rejects.toThrow(/must use https/);
    await expect(
      discover({
        issuer: "https://mcp.example.com",
        authorization_endpoint: "https://mcp.example.com/authorize",
        token_endpoint: "https://mcp.example.com/token",
        code_challenge_methods_supported: ["plain"],
      }),
    ).rejects.toThrow(/PKCE S256/);
    await expect(
      discover({ issuer: "https://mcp.example.com", token_endpoint: "https://mcp.example.com/token" }),
    ).rejects.toThrow(/authorization_endpoint is missing/);
  });
});

describe("MCP OAuth authorization request", () => {
  it("derives an S256 challenge from the verifier", () => {
    const pair = createMcpPkcePair();
    expect(pair.method).toBe("S256");
    expect(pair.challenge).toBe(createHash("sha256").update(pair.verifier).digest("base64url"));
    expect(createMcpPkcePair().verifier).not.toBe(pair.verifier);
  });

  it("builds an authorization URL carrying PKCE, state, and the resource binding", () => {
    const url = new URL(
      buildMcpAuthorizationUrl(METADATA, {
        clientId: "client-1",
        redirectUri: "http://127.0.0.1:51234/callback",
        state: "state-1",
        challenge: "challenge-1",
        scope: "mcp:read",
        resource: "https://mcp.example.com/mcp",
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-1",
      redirect_uri: "http://127.0.0.1:51234/callback",
      state: "state-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
      scope: "mcp:read",
      resource: "https://mcp.example.com/mcp",
    });
  });

  it("refuses a redirect URI that is neither https nor loopback", () => {
    expect(() =>
      buildMcpAuthorizationUrl(METADATA, {
        clientId: "client-1",
        redirectUri: "http://example.com/callback",
        state: "s",
        challenge: "c",
      }),
    ).toThrow(/must use https/);
  });
});

describe("MCP OAuth callback", () => {
  it("accepts only a callback whose state matches exactly", () => {
    expect(readMcpOAuthCallback("/callback?code=abc&state=expected", "expected")).toEqual({ code: "abc" });
    expect(() => readMcpOAuthCallback("/callback?code=abc&state=other", "expected")).toThrow(/state did not match/);
    expect(() => readMcpOAuthCallback("/callback?code=abc", "expected")).toThrow(/state did not match/);
    expect(() => readMcpOAuthCallback("/callback?state=expected", "expected")).toThrow(/no authorization code/);
  });

  it("surfaces a denied authorization instead of waiting for a code", () => {
    expect(() =>
      readMcpOAuthCallback("/callback?error=access_denied&error_description=User%20said%20no", "expected"),
    ).toThrow(/access_denied \(User said no\)/);
  });
});

describe("MCP OAuth token exchange", () => {
  it("posts the verifier and returns the issued tokens", async () => {
    let body: string | undefined;
    const tokens = await exchangeMcpAuthorizationCode(
      METADATA,
      {
        code: "code-1",
        verifier: "verifier-1",
        clientId: "client-1",
        redirectUri: "http://127.0.0.1:51234/callback",
        resource: "https://mcp.example.com/mcp",
      },
      {
        fetchImpl: async (url, init) => {
          expect(url).toBe("https://auth.example.com/token");
          body = String(init?.body);
          return json({ access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "Bearer" });
        },
      },
    );
    const sent = new URLSearchParams(body ?? "");
    expect(Object.fromEntries(sent)).toMatchObject({
      grant_type: "authorization_code",
      code: "code-1",
      code_verifier: "verifier-1",
      client_id: "client-1",
      resource: "https://mcp.example.com/mcp",
    });
    expect(tokens).toMatchObject({ accessToken: "at", refreshToken: "rt", tokenType: "Bearer" });
    expect(Date.parse(tokens.expiresAt!)).toBeGreaterThan(Date.now());
  });

  it("fails loudly on an error status, invalid JSON, or a missing access token", async () => {
    const exchange = (response: Response) =>
      exchangeMcpAuthorizationCode(
        METADATA,
        { code: "c", verifier: "v", clientId: "client-1", redirectUri: "http://127.0.0.1:1/callback" },
        { fetchImpl: async () => response },
      );

    await expect(exchange(json({ error: "invalid_grant" }, 400))).rejects.toThrow(/HTTP 400/);
    await expect(exchange(new Response("<html>", { status: 200 }))).rejects.toThrow(/invalid JSON/);
    await expect(exchange(json({ token_type: "Bearer" }))).rejects.toThrow(/omitted access_token/);
  });

  it("requires dynamic registration support before registering a client", async () => {
    const { registrationEndpoint: _omitted, ...withoutRegistration } = METADATA;
    await expect(
      registerMcpOAuthClient(withoutRegistration, { redirectUri: "http://127.0.0.1:1/callback", clientName: "x" }),
    ).rejects.toThrow(/neither a configured client id nor dynamic registration/);

    const client = await registerMcpOAuthClient(
      METADATA,
      { redirectUri: "http://127.0.0.1:1/callback", clientName: "SeekForge" },
      { fetchImpl: async () => json({ client_id: "generated" }) },
    );
    expect(client).toEqual({ clientId: "generated" });
  });
});

describe("MCP OAuth credential store", () => {
  let home: string;
  const previousHome = process.env.SEEKFORGE_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "seekforge-oauth-home-"));
    process.env.SEEKFORGE_HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.SEEKFORGE_HOME;
    else process.env.SEEKFORGE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  const identity = {
    serverName: "docs",
    serverUrl: "https://mcp.example.com/mcp",
    tokenEndpoint: "https://auth.example.com/token",
    clientId: "client-1",
  };

  it("stores credentials owner-only, outside the shared config file", () => {
    recordMcpOAuthTokens(identity, { accessToken: "at", refreshToken: "rt", tokenType: "Bearer" });
    const path = mcpOAuthStorePath();
    expect(path).toBe(join(home, ".seekforge", "mcp-oauth.json"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readMcpOAuthCredential("docs", identity.serverUrl)).toMatchObject({ refreshToken: "rt" });
  });

  it("keeps the previous refresh token when a renewal does not rotate it", () => {
    recordMcpOAuthTokens(identity, { accessToken: "at", refreshToken: "rt", tokenType: "Bearer" });
    recordMcpOAuthTokens(identity, { accessToken: "at2", tokenType: "Bearer" });
    expect(readMcpOAuthCredential("docs", identity.serverUrl)).toMatchObject({
      accessToken: "at2",
      refreshToken: "rt",
    });

    recordMcpOAuthTokens(identity, { accessToken: "at3", refreshToken: "rt2", tokenType: "Bearer" });
    expect(readMcpOAuthCredential("docs", identity.serverUrl)?.refreshToken).toBe("rt2");
  });

  it("does not reuse a credential after the server name points at a different URL", () => {
    saveMcpOAuthCredential({ ...identity, refreshToken: "rt" });
    expect(readMcpOAuthCredential("docs", "https://other.example.com/mcp")).toBeUndefined();
    expect(listMcpOAuthCredentials()).toHaveLength(1);
  });

  it("deletes by name, and reports whether anything was removed", () => {
    saveMcpOAuthCredential({ ...identity, refreshToken: "rt" });
    saveMcpOAuthCredential({ ...identity, serverUrl: "https://other.example.com/mcp", refreshToken: "rt2" });
    expect(deleteMcpOAuthCredential("docs", identity.serverUrl)).toBe(true);
    expect(listMcpOAuthCredentials()).toHaveLength(1);
    expect(deleteMcpOAuthCredential("docs")).toBe(true);
    expect(listMcpOAuthCredentials()).toEqual([]);
    expect(deleteMcpOAuthCredential("docs")).toBe(false);
  });

  it("ignores oversized and structurally invalid credential stores", () => {
    const path = mcpOAuthStorePath();
    mkdirSync(join(home, ".seekforge"), { recursive: true });
    writeFileSync(path, "x".repeat(256 * 1024 + 1));
    expect(listMcpOAuthCredentials()).toEqual([]);

    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        credentials: [
          { ...identity, updatedAt: new Date().toISOString(), unexpected: "field" },
          { ...identity, serverUrl: "file:///tmp/token", updatedAt: new Date().toISOString() },
        ],
      }),
    );
    expect(listMcpOAuthCredentials()).toEqual([]);
  });

  it("rejects invalid credentials before persisting them", () => {
    expect(() => saveMcpOAuthCredential({ ...identity, accessToken: "x".repeat(16 * 1024 + 1) })).toThrow(/invalid/);
    expect(listMcpOAuthCredentials()).toEqual([]);
  });
});
