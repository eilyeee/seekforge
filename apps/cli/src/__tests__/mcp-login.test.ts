// End-to-end test of `seekforge mcp login` against a local OAuth + MCP server:
// discovery, dynamic registration, PKCE, the loopback callback, and where the
// resulting credential is (and is not) written.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { mcpLoginCommand, mcpLogoutCommand } from "../commands/mcp-login.js";

type AuthServer = { base: string; close: () => Promise<void>; received: Record<string, string> };

/** A minimal authorization server: metadata, dynamic registration, token exchange. */
async function startAuthServer(options: { rotateRefresh?: boolean } = {}): Promise<AuthServer> {
  const received: Record<string, string> = {};
  let base = "";
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", base);
    const json = (body: unknown, status = 200): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      json({ resource: `${base}/mcp`, authorization_servers: [base] });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["mcp:read"],
      });
      return;
    }
    if (url.pathname === "/register") {
      json({ client_id: "generated-client" });
      return;
    }
    if (url.pathname === "/token") {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        for (const [key, value] of new URLSearchParams(body)) received[key] = value;
        json({
          access_token: "access-1",
          token_type: "Bearer",
          expires_in: 3600,
          ...(options.rotateRefresh === false ? {} : { refresh_token: "refresh-1" }),
        });
      });
      return;
    }
    json({ error: "not_found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    get base() {
      return base;
    },
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let home: string;
let project: string;
let auth: AuthServer;
let cwd: string;
const logs: string[] = [];
const originalLog = console.log;
const originalHome = process.env.SEEKFORGE_HOME;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "sf-mcp-login-home-"));
  project = mkdtempSync(join(tmpdir(), "sf-mcp-login-proj-"));
  process.env.SEEKFORGE_HOME = home;
  process.env.SEEKFORGE_NO_BROWSER = "1";
  auth = await startAuthServer();
  mkdirSync(join(project, ".seekforge"), { recursive: true });
  writeFileSync(
    join(project, ".seekforge", "config.json"),
    JSON.stringify({ mcpServers: { docs: { url: `${auth.base}/mcp` }, local: { command: "npx" } } }),
  );
  cwd = process.cwd();
  process.chdir(project);
  logs.length = 0;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(async () => {
  console.log = originalLog;
  process.chdir(cwd);
  await auth.close();
  if (originalHome === undefined) delete process.env.SEEKFORGE_HOME;
  else process.env.SEEKFORGE_HOME = originalHome;
  delete process.env.SEEKFORGE_NO_BROWSER;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

/** Waits for the printed authorization URL, then plays the browser's part. */
async function consentInBrowser(code = "auth-code-1"): Promise<URL> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const printed = logs.find((line) => line.includes("/authorize?"));
    if (printed) {
      const authorizationUrl = new URL(printed.trim());
      const redirect = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
      const response = await fetch(redirect.toString());
      await response.text();
      return authorizationUrl;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`authorization URL was never printed; logs: ${logs.join(" | ")}`);
}

test("logs in with PKCE and stores the credential outside the project config", async () => {
  const login = mcpLoginCommand("docs");
  const authorizationUrl = await consentInBrowser();
  await login;

  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizationUrl.searchParams.get("client_id"), "generated-client");
  assert.equal(authorizationUrl.searchParams.get("scope"), "mcp:read");
  assert.equal(authorizationUrl.searchParams.get("resource"), `${auth.base}/mcp`);

  // The verifier the server received must hash to the challenge it was shown.
  const verifier = auth.received.code_verifier ?? "";
  assert.equal(
    createHash("sha256").update(verifier).digest("base64url"),
    authorizationUrl.searchParams.get("code_challenge"),
  );
  assert.equal(auth.received.grant_type, "authorization_code");
  assert.equal(auth.received.code, "auth-code-1");

  const storePath = join(home, ".seekforge", "mcp-oauth.json");
  const stored = JSON.parse(readFileSync(storePath, "utf8")) as {
    credentials: { serverName: string; refreshToken: string; clientId: string }[];
  };
  expect(stored.credentials).toEqual([
    expect.objectContaining({ serverName: "docs", refreshToken: "refresh-1", clientId: "generated-client" }),
  ]);
  assert.equal(statSync(storePath).mode & 0o777, 0o600);
  // The secret must never land in the shared, committable project config.
  assert.ok(!readFileSync(join(project, ".seekforge", "config.json"), "utf8").includes("refresh-1"));
});

test("uses a pre-registered client when the server has no dynamic registration", async () => {
  const login = mcpLoginCommand("docs", { clientId: "preregistered", clientSecret: "shh", scope: "mcp:write" });
  const authorizationUrl = await consentInBrowser();
  await login;

  assert.equal(authorizationUrl.searchParams.get("client_id"), "preregistered");
  assert.equal(authorizationUrl.searchParams.get("scope"), "mcp:write");
  assert.equal(auth.received.client_secret, "shh");
});

/** fail() writes to stderr and sets process.exitCode; capture both, restore both. */
async function captureFailure(run: () => Promise<void>): Promise<string> {
  const written: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  const previousExitCode = process.exitCode;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = originalWrite;
    process.exitCode = previousExitCode;
  }
  return written.join("");
}

test("rejects a callback whose state does not match, and stores nothing", async () => {
  const failure = await captureFailure(async () => {
    const login = mcpLoginCommand("docs");
    for (let attempt = 0; attempt < 200 && !logs.some((line) => line.includes("/authorize?")); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const printed = logs.find((line) => line.includes("/authorize?")) ?? "";
    const redirect = new URL(new URL(printed.trim()).searchParams.get("redirect_uri") ?? "");
    redirect.searchParams.set("code", "auth-code-1");
    redirect.searchParams.set("state", "forged-state");
    const response = await fetch(redirect.toString());
    assert.equal(response.status, 400);
    await response.text();
    await login;
  });

  assert.match(failure, /state did not match/);
  assert.ok(!logs.some((line) => line.includes("stored credentials")));
  assert.equal(auth.received.code, undefined, "no token exchange may happen for a forged callback");
});

test("refuses stdio servers and reports logout for an unknown credential", async () => {
  const failure = await captureFailure(async () => {
    await mcpLoginCommand("local");
    await mcpLoginCommand("missing");
  });
  assert.match(failure, /stdio server/);
  assert.match(failure, /no MCP server named "missing"/);

  mcpLogoutCommand("docs");
  assert.match(logs.join("\n"), /no stored credentials/);
});
