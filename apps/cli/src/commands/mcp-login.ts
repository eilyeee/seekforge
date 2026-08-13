import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildMcpAuthorizationUrl,
  createMcpOAuthState,
  createMcpPkcePair,
  deleteMcpOAuthCredential,
  discoverMcpOAuthMetadata,
  exchangeMcpAuthorizationCode,
  type McpOAuthClient,
  type McpOAuthMetadata,
  readMcpOAuthCallback,
  recordMcpOAuthTokens,
  registerMcpOAuthClient,
} from "@seekforge/core";
import { dim, fail } from "../colors.js";
import { ensureWorkspaceAuthorized } from "./run.js";
import { loadConfig, resolveConfig } from "../config.js";
import { t } from "../i18n.js";

const AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;

/**
 * Best-effort browser launch; the URL is always printed, so failure is fine.
 * SEEKFORGE_NO_BROWSER skips the launch entirely for headless hosts and tests.
 */
function openInBrowser(url: string): void {
  if (process.env.SEEKFORGE_NO_BROWSER) return;
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command as string, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Headless machines have no browser; the printed URL is the fallback.
  }
}

const page = (message: string): string =>
  `<!doctype html><meta charset="utf-8"><title>SeekForge</title>` +
  `<body style="font:16px system-ui;padding:3rem"><p>${message}</p></body>`;

type LoopbackReceiver = { redirectUri: string; code: Promise<string>; close: () => void };

/**
 * Serves exactly one loopback callback. Binding to 127.0.0.1 keeps the redirect
 * off the network, and the listener closes as soon as the code arrives, the
 * timeout fires, or the user interrupts — no port is left waiting.
 */
async function startLoopbackReceiver(state: string, signal: AbortSignal): Promise<LoopbackReceiver> {
  let settle: ((result: { code?: string; error?: unknown }) => void) | undefined;
  const settled = new Promise<{ code?: string; error?: unknown }>((resolve) => {
    settle = resolve;
  });
  const server = createServer((request, response) => {
    try {
      const { code } = readMcpOAuthCallback(request.url ?? "/", state);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page(t("cmd.mcpLogin.browserDone")));
      settle?.({ code });
    } catch (error) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end(page(t("cmd.mcpLogin.browserFailed")));
      settle?.({ error });
    }
  });
  const timer = setTimeout(() => settle?.({ error: new Error(t("cmd.mcpLogin.timedOut")) }), AUTHORIZATION_TIMEOUT_MS);
  timer.unref?.();
  const onAbort = () => settle?.({ error: new Error(t("cmd.mcpLogin.cancelled")) });
  signal.addEventListener("abort", onAbort, { once: true });
  server.on("error", (error) => settle?.({ error }));

  const redirectUri = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}/callback`);
    });
  });

  const close = (): void => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    server.close();
  };
  const code = settled.then((result) => {
    close();
    if (result.error !== undefined) throw result.error;
    return result.code as string;
  });
  return { redirectUri, code, close };
}

/**
 * `seekforge mcp login <name>` — run the interactive OAuth 2.1 authorization
 * code flow (PKCE) against a configured remote MCP server, then store the
 * refresh token outside the shared config file.
 */
export async function mcpLoginCommand(
  name: string,
  opts: { scope?: string; clientId?: string; clientSecret?: string; yes?: boolean } = {},
): Promise<void> {
  const projectPath = process.cwd();
  const { config, mcpOrigins } = resolveConfig(projectPath);
  const server = config.mcpServers?.[name];
  if (!server) {
    fail(t("cmd.mcpLogin.unknownServer", { name }), { hint: t("cmd.mcpLogin.unknownServerHint") });
    return;
  }
  const serverUrl = server.url;
  if (!serverUrl) {
    fail(t("cmd.mcpLogin.notRemote", { name }));
    return;
  }
  // A repository layer can no longer repoint a name you own, but a name only it
  // defines still carries a URL the checkout chose — and this command runs OAuth
  // discovery against it, registers a client, and opens a browser at whatever
  // authorization page it names. You picked the name; the checkout picked where
  // it points. Same folder-access consent `mcp list` and `run` take.
  if (mcpOrigins[name] === "repository") {
    console.log(t("cmd.mcpLogin.fromRepository", { name, url: serverUrl }));
    if (!(await ensureWorkspaceAuthorized(projectPath, { yes: opts.yes === true, machine: false }))) return;
  }
  if (server.oauth) {
    fail(t("cmd.mcpLogin.alreadyConfigured", { name }));
    return;
  }

  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  let receiver: LoopbackReceiver | undefined;
  try {
    let metadata: McpOAuthMetadata;
    try {
      metadata = await discoverMcpOAuthMetadata(serverUrl, { signal: controller.signal });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error), { hint: t("cmd.mcpLogin.discoveryHint") });
      return;
    }
    console.log(t("cmd.mcpLogin.discovered", { issuer: metadata.issuer }));

    const scope = opts.scope ?? metadata.scopesSupported?.join(" ");
    const pkce = createMcpPkcePair();
    const state = createMcpOAuthState();
    // Listen first: the client must be registered for the exact redirect URI
    // the listener ended up bound to, so the port can never drift between them.
    receiver = await startLoopbackReceiver(state, controller.signal);

    const client: McpOAuthClient = opts.clientId
      ? { clientId: opts.clientId, ...(opts.clientSecret !== undefined ? { clientSecret: opts.clientSecret } : {}) }
      : await registerMcpOAuthClient(
          metadata,
          { redirectUri: receiver.redirectUri, clientName: "SeekForge", ...(scope ? { scope } : {}) },
          { signal: controller.signal },
        );

    const authorizationUrl = buildMcpAuthorizationUrl(metadata, {
      clientId: client.clientId,
      redirectUri: receiver.redirectUri,
      state,
      challenge: pkce.challenge,
      ...(scope ? { scope } : {}),
      resource: serverUrl,
    });
    console.log(t("cmd.mcpLogin.openBrowser"));
    console.log(`  ${authorizationUrl}`);
    openInBrowser(authorizationUrl);

    const code = await receiver.code;
    const tokens = await exchangeMcpAuthorizationCode(
      metadata,
      {
        code,
        verifier: pkce.verifier,
        clientId: client.clientId,
        ...(client.clientSecret !== undefined ? { clientSecret: client.clientSecret } : {}),
        redirectUri: receiver.redirectUri,
        resource: serverUrl,
      },
      { signal: controller.signal },
    );
    const credential = recordMcpOAuthTokens(
      {
        serverName: name,
        serverUrl,
        tokenEndpoint: metadata.tokenEndpoint,
        clientId: client.clientId,
        ...(client.clientSecret !== undefined ? { clientSecret: client.clientSecret } : {}),
      },
      tokens,
    );
    console.log(t("cmd.mcpLogin.stored", { name }));
    if (!credential.refreshToken) console.log(dim(t("cmd.mcpLogin.noRefreshToken")));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    receiver?.close();
    process.removeListener("SIGINT", onInterrupt);
  }
}

/** `seekforge mcp logout <name>` — forget a stored OAuth credential. */
export function mcpLogoutCommand(name: string): void {
  const config = loadConfig(process.cwd());
  const url = config.mcpServers?.[name]?.url;
  const removed = url ? deleteMcpOAuthCredential(name, url) : deleteMcpOAuthCredential(name);
  console.log(removed ? t("cmd.mcpLogin.removed", { name }) : t("cmd.mcpLogin.nothingStored", { name }));
}
