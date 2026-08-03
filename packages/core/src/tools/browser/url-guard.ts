import { ToolError } from "../errors.js";
import { assertPublicResolvedUrl, checkFetchUrl, type LookupAll } from "../builtins/web.js";

/**
 * Which URLs the browser tools may open.
 *
 * Same rule as web_fetch — no private networks — with one deliberate exception:
 * loopback. Verifying a frontend change means opening the developer's own dev
 * server, which is exactly the address web_fetch refuses. Everything else stays
 * refused, including the cloud metadata endpoints and LAN hosts that make SSRF
 * worth caring about.
 */

/** True for the developer's own machine: localhost, 127.0.0.0/8, or ::1. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

/** Browser verification may target a developer's loopback server, but no other private network. */
export function checkBrowserUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolError("invalid_url", `Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolError("invalid_url", `Only http/https URLs are allowed (got ${url.protocol})`);
  }
  if (isLoopbackHost(url.hostname)) return url;
  return checkFetchUrl(raw);
}

/** Apply the DNS-level SSRF check while preserving explicit loopback dev-server access. */
export async function assertBrowserUrlAllowed(raw: string, resolver?: LookupAll, signal?: AbortSignal): Promise<URL> {
  const url = checkBrowserUrl(raw);
  if (isLoopbackHost(url.hostname)) return url;
  await assertPublicResolvedUrl(url, resolver, signal);
  return url;
}
