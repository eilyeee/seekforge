import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { z } from "zod";
import { DEFAULT_LIMITS } from "@seekforge/shared";
import { abortablePromise, onAbortOnce } from "../../util/abort.js";
import { readResponseBody } from "../../util/response-body.js";
import { ToolError } from "../errors.js";
import { redactSecrets } from "../redact.js";
import { truncateHeadTail } from "../text.js";
import { defineTool, type ToolSpec } from "../registry.js";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

type ResolvedAddress = { address: string; family: number };
export type LookupAll = (hostname: string) => Promise<readonly ResolvedAddress[]>;

const lookupAll: LookupAll = (hostname) => lookup(hostname, { all: true, verbatim: true });

/**
 * SSRF guard: refuse non-http(s) schemes and private/loopback/link-local
 * targets — the agent must not be able to probe the local network.
 */
/**
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d`, which WHATWG serializes as `::ffff:7f00:1`)
 * lets an attacker smuggle a private IPv4 past the string checks. Decode the
 * embedded IPv4 so the dotted-quad rules below catch it. Returns null when the
 * host isn't IPv4-mapped.
 */
function mappedIpv4(host: string): string | null {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host);
  if (dotted) return dotted[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (hex) {
    const hi = Number.parseInt(hex[1]!, 16);
    const lo = Number.parseInt(hex[2]!, 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return null;
}

/** True when a resolved IP is not a globally-routable fetch target. */
export function isPrivateAddress(address: string): boolean {
  const host = address.toLowerCase().split("%")[0]!;
  const mapped = mappedIpv4(host);
  if (mapped !== null) return isPrivateAddress(mapped);

  if (isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    const a = octets[0]!;
    const b = octets[1]!;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (isIP(host) === 6) {
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      /^fe[89ab]/.test(host) ||
      host.startsWith("ff")
    );
  }
  return false;
}

/**
 * Validate that `url` resolves only to public addresses and return the
 * validated set so the caller can PIN the socket to one of them.
 *
 * Returns `null` for an IP-literal host (nothing to pin — the connect target is
 * the literal itself). For a hostname, returns the resolved public addresses;
 * the caller must connect to one of these exact IPs rather than re-resolving,
 * otherwise a TTL-0 attacker DNS can answer public here and private at connect
 * time (DNS rebinding).
 */
export async function assertPublicResolvedUrl(
  url: URL,
  resolver: LookupAll = lookupAll,
  signal?: AbortSignal,
): Promise<readonly ResolvedAddress[] | null> {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) {
      throw new ToolError("private_address", `Refusing to fetch a private/loopback address: ${host}`);
    }
    return null;
  }

  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await abortablePromise(
      resolver(host),
      signal,
      () => new ToolError("fetch_failed", `DNS lookup cancelled for ${host}`),
    );
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError(
      "fetch_failed",
      `DNS lookup failed for ${host}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (addresses.length === 0) {
    throw new ToolError("fetch_failed", `DNS lookup returned no addresses for ${host}`);
  }
  const blocked = addresses.find(({ address }) => isPrivateAddress(address));
  if (blocked) {
    throw new ToolError(
      "private_address",
      `Refusing to fetch ${host}: it resolves to a private/loopback address (${blocked.address})`,
    );
  }
  return addresses;
}

/**
 * Parse one part of a numeric host as `inet_aton` does: `0x..` is hex, a leading
 * `0` (with more digits) is octal, otherwise decimal. Returns the numeric value,
 * or null when the token is malformed for the base it declares (e.g. `08` is not
 * valid octal, `0xzz` not hex) — the caller treats null as "block".
 */
function parseNumericPart(part: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(part)) return Number.parseInt(part.slice(2), 16);
  if (/^0[0-7]*$/.test(part)) return Number.parseInt(part, 8); // "0", "00", octal
  if (/^[1-9][0-9]*$/.test(part)) return Number.parseInt(part, 10); // decimal
  return null; // digit-led token that is not a valid number in its base
}

/**
 * Bare integer / octal / hex hosts (`2130706433`, `0177.0.0.1`, `0x7f.0.0.1`,
 * `0`) resolve to the same address as a dotted-quad but sail past a plain
 * regex, so decode them to canonical dotted-quad first. Returns:
 *   - the dotted-quad string when `host` is a numeric IPv4 form,
 *   - "invalid" when it *looks* numeric (every dot-part is a digit/hex token)
 *     but is malformed or out of range — fail closed and let the caller block,
 *   - null when it is a normal hostname (leave it for the string checks).
 * Follows `inet_aton` part-count semantics (1→32-bit, 2→a.24-bit, 3→a.b.16-bit,
 * 4→a.b.c.d), which is what the OS resolver actually applies.
 *
 * Exported for direct testing: in practice Node's WHATWG `URL` parser already
 * canonicalizes these numeric hosts (and rejects out-of-range ones), so within
 * `checkFetchUrl` this is a redundant safety net — but it must be correct for
 * any caller that hands us a host string that did not go through `new URL`.
 */
export function normalizeNumericIpv4(host: string): string | "invalid" | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  // Only a host whose every part is a numeric token is an IPv4 candidate; a
  // single non-numeric label (e.g. "com", "3com") means it's a real hostname.
  if (!parts.every((p) => /^(0x[0-9a-f]+|[0-9]+)$/i.test(p))) return null;

  const values = parts.map(parseNumericPart);
  if (values.some((v) => v === null)) return "invalid"; // numeric-looking but malformed
  const nums = values as number[];

  // inet_aton: the last part absorbs the remaining low-order bytes; every
  // earlier part must fit in a single byte.
  const last = nums[nums.length - 1]!;
  const head = nums.slice(0, -1);
  const maxLast = 2 ** (8 * (4 - head.length)) - 1;
  if (last < 0 || last > maxLast) return "invalid";
  if (head.some((n) => n < 0 || n > 0xff)) return "invalid";

  let value = last >>> 0;
  for (let i = 0; i < head.length; i++) {
    value += head[i]! * 2 ** (8 * (3 - i));
  }
  value = value >>> 0;
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
}

export function checkFetchUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolError("invalid_url", `Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolError("invalid_url", `Only http/https URLs are allowed (got ${url.protocol})`);
  }
  // IPv6 hostnames keep their brackets in WHATWG URLs — strip for matching, but
  // remember it was a literal (so "fc2.com" isn't mistaken for fc00::/7).
  const isIpv6Literal = url.hostname.startsWith("[");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // Numeric hosts (bare integer / octal / hex) resolve to a real IPv4 but bypass
  // the dotted-quad regexes — decode them first. A numeric-looking but malformed
  // or out-of-range host is treated as suspicious and blocked (fail closed).
  const numeric = isIpv6Literal ? null : normalizeNumericIpv4(host);
  if (numeric === "invalid") {
    throw new ToolError("private_address", `Refusing to fetch a suspicious numeric address: ${host}`);
  }
  // An IPv4-mapped literal resolves to its embedded IPv4 — check that instead.
  const ipv4 = numeric ?? mappedIpv4(host) ?? host;
  const isPrivate =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isPrivateAddress(ipv4);
  if (isPrivate) {
    throw new ToolError("private_address", `Refusing to fetch a private/loopback address: ${host}`);
  }
  return url;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * A single non-redirect-following GET. `addresses` (from assertPublicResolvedUrl)
 * pins the socket to a pre-validated IP; null means the host is already an IP
 * literal and needs no pinning.
 */
export type PinnedTransport = (
  url: URL,
  addresses: readonly ResolvedAddress[] | null,
  signal: AbortSignal,
) => Promise<Response>;

/**
 * Connect to the exact validated IP instead of letting the HTTP stack resolve
 * the hostname a second time. Uses node:http(s) with a `lookup` override that
 * always returns the pinned address — the URL's hostname still drives SNI and
 * certificate validation, so TLS is unaffected. `fetch()` (undici) offers no
 * way to pin without the undici package, hence the native client here.
 */
export const pinnedTransport: PinnedTransport = async (url, addresses, signal) => {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const pinned = addresses?.[0];
  const lookupOverride: LookupFunction | undefined =
    pinned === undefined
      ? undefined
      : (_hostname, options, callback) => {
          if (options.all) {
            (callback as (err: NodeJS.ErrnoException | null, addrs: ResolvedAddress[]) => void)(null, [
              { address: pinned.address, family: pinned.family },
            ]);
          } else {
            callback(null, pinned.address, pinned.family);
          }
        };
  return await new Promise<Response>((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        headers: { "user-agent": "seekforge-agent", host: url.host },
        signal,
        ...(lookupOverride ? { lookup: lookupOverride } : {}),
      },
      (res) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) for (const v of value) headers.append(key, v);
          else if (value !== undefined) headers.set(key, value);
        }
        const status = res.statusCode ?? 502;
        // 204/304 must have a null body per the Response constructor contract.
        const body = status === 204 || status === 304 ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
        resolve(new Response(body, { status, headers }));
      },
    );
    req.on("error", (err) => reject(new ToolError("fetch_failed", `Fetch failed: ${err.message}`)));
    req.end();
  });
};

/** Fetch one public URL, validating DNS and every redirect target before use. */
export async function fetchPublicResponse(
  initialUrl: URL,
  signal: AbortSignal,
  deps: { resolver?: LookupAll; transport?: PinnedTransport } = {},
): Promise<{ response: Response; finalUrl: URL }> {
  const transport = deps.transport ?? pinnedTransport;
  let current = initialUrl;
  for (let redirects = 0; ; redirects++) {
    const addresses = await assertPublicResolvedUrl(current, deps.resolver, signal);
    const response = await transport(current, addresses, signal);
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
    if (location === null) return { response, finalUrl: current };
    await response.body?.cancel().catch(() => undefined);
    if (redirects >= MAX_REDIRECTS) {
      throw new ToolError("too_many_redirects", `Fetch exceeded ${MAX_REDIRECTS} redirects`);
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new ToolError("invalid_url", `Redirect returned an invalid URL: ${location}`);
    }
    current = checkFetchUrl(next.toString());
  }
}

export { readResponseBody } from "../../util/response-body.js";

/** Crude readable-text extraction for HTML pages (no DOM dependency). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

const webFetchSchema = z.object({
  url: z.string().describe("Absolute http(s) URL to fetch (docs, issues, READMEs)."),
  extract: z
    .string()
    .optional()
    .describe(
      "Optional question/keywords. When set AND the page is too long to return " +
        "in full, the returned text is biased toward the lines that match these " +
        "keywords (instead of a plain head+tail truncation), so the relevant " +
        "part survives. You still summarize the returned text yourself.",
    ),
});

/** Tokenizes an extract query into lowercased keywords for line scoring. */
function extractKeywords(extract: string): string[] {
  return Array.from(
    new Set(
      extract
        .toLowerCase()
        .split(/[^a-z0-9_]+/i)
        .map((w) => w.trim())
        .filter((w) => w.length >= 3),
    ),
  );
}

/**
 * Relevance-biased truncation for web_fetch: when the stripped text is over
 * the cap and an `extract` query is given, keep a head plus the highest-scoring
 * lines (scored by how many extract keywords they contain), preserving original
 * order. No model call — this is honest keyword selection, not summarization;
 * full LLM-summarize-on-fetch would need a provider plumbed into tools and is a
 * follow-up. Falls back to plain head+tail when nothing matches.
 */
export function extractRelevant(text: string, extract: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const keywords = extractKeywords(extract);
  if (keywords.length === 0) return truncateHeadTail(text, maxChars);

  const lines = text.split("\n");
  // Always keep a head so the page's context/title survives; spend the rest of
  // the budget on the best-matching lines in their original order.
  const HEAD_LINES = 15;
  const head = lines.slice(0, HEAD_LINES);
  const headText = head.join("\n");
  const marker = "\n... [non-matching sections omitted] ...\n";
  let budget = maxChars - headText.length - marker.length;
  if (budget <= 0) return truncateHeadTail(text, maxChars);

  const scored = lines
    .map((line, idx) => {
      if (idx < HEAD_LINES) return { idx, score: 0 };
      const lower = line.toLowerCase();
      let score = 0;
      for (const kw of keywords) if (lower.includes(kw)) score++;
      return { idx, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return truncateHeadTail(text, maxChars);

  const keep = new Set<number>();
  for (const { idx } of scored) {
    if (budget <= 0) break;
    keep.add(idx);
    budget -= lines[idx]!.length + 1;
  }
  const kept = [...keep].sort((a, b) => a - b).map((idx) => lines[idx]!);
  return { text: `${headText}${marker}${kept.join("\n")}`, truncated: true };
}

const webFetch = defineTool({
  name: "web_fetch",
  description:
    "Fetch a public http(s) url and return its readable text (HTML is stripped, output capped at 20k chars). Pass `extract` (a question or keywords) to bias the truncation toward the most relevant lines when the page is long — you still summarize the returned text yourself. Every fetch requires user confirmation and private/loopback addresses are refused — fetch only when the page genuinely adds information (docs, issues, changelogs), not for things the codebase already answers.",
  schema: webFetchSchema,
  // "env" level: always confirmed, even in auto-approval mode — the network
  // is off by default (docs/14 §3.5) and every URL is shown raw to the user.
  classify: (args) => ({
    permission: "env",
    description: `Fetch URL: ${args.url}`,
    command: `GET ${args.url}`,
  }),
  async run(args, ctx) {
    const url = checkFetchUrl(args.url);

    const controller = new AbortController();
    const offAbort = onAbortOnce(ctx.signal, () => controller.abort());
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const { response: res, finalUrl } = await fetchPublicResponse(url, controller.signal);
      const contentType = res.headers.get("content-type") ?? "";
      if (!/text\/|json|xml|javascript/i.test(contentType)) {
        await res.body?.cancel().catch(() => undefined);
        throw new ToolError("unsupported_content", `Unsupported content-type: ${contentType || "unknown"}`);
      }

      const buf = await readResponseBody(res);
      let text = buf.toString("utf8");
      if (/text\/html/i.test(contentType)) text = htmlToText(text);

      // With an `extract` query, bias the truncation toward matching lines so
      // the relevant part survives the cap; otherwise plain head+tail.
      const extract = args.extract?.trim();
      const { text: capped, truncated } =
        extract !== undefined && extract !== ""
          ? extractRelevant(text, extract, DEFAULT_LIMITS.toolOutputMaxChars)
          : truncateHeadTail(text, DEFAULT_LIMITS.toolOutputMaxChars);
      return {
        data: {
          url: finalUrl.toString(),
          status: res.status,
          contentType,
          content: redactSecrets(capped),
        },
        meta: { truncated },
      };
    } catch (err) {
      if (ctx.signal?.aborted) throw new ToolError("cancelled", "Web fetch cancelled");
      if (err instanceof ToolError) throw err;
      throw new ToolError("fetch_failed", `Fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      offAbort();
      clearTimeout(timer);
    }
  },
});

const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";

export type WebSearchResult = { title: string; url: string; snippet: string };

/**
 * Decodes a DuckDuckGo HTML result href. DDG wraps every result URL as
 * `/l/?uddg=<percent-encoded target>&...`; protocol-relative hrefs start with
 * `//duckduckgo.com/l/?...`. Returns the decoded absolute http(s) URL, or
 * undefined when the href is not a usable redirect target.
 */
export function decodeDdgUrl(href: string): string | undefined {
  let raw = href.trim();
  if (raw.startsWith("//")) raw = "https:" + raw;
  // Relative `/l/?uddg=...` — give it a base so URLSearchParams can read it.
  const candidate = raw.startsWith("/") ? "https://duckduckgo.com" + raw : raw;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }
  const uddg = parsed.searchParams.get("uddg");
  const target = uddg ?? candidate;
  let out: URL;
  try {
    out = new URL(target);
  } catch {
    return undefined;
  }
  if (out.protocol !== "http:" && out.protocol !== "https:") return undefined;
  // Skip DDG's own ad/redirect noise that does not resolve to a real target.
  if (!uddg && /(^|\.)duckduckgo\.com$/i.test(out.hostname)) return undefined;
  return out.toString();
}

function decodeEntities(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What a results page with no parsed rows actually was.
 *
 * `parseDdgResults` returning [] used to mean three different things — the
 * query genuinely had no hits, DuckDuckGo changed its markup, or the request
 * was answered with a block/captcha page — and the tool reported one note
 * covering all of them. The model cannot act on that: "no hits" means believe
 * it, "drift" and "blocked" mean the search did not happen. Distinguishing them
 * costs one scan of the page.
 */
export type SearchPageKind = "results" | "empty" | "drift" | "blocked";

/** Markers of a real DDG results page, whether or not any row parsed. */
const DDG_PAGE_MARKERS = ["result__a", "results_links", "no-results", 'id="links"'];
/** Markers of the interstitial DDG serves instead of results. */
const DDG_BLOCK_MARKERS = ["anomaly", "captcha", "unusual traffic", "challenge-form"];

export function classifySearchPage(html: string, parsedCount: number): SearchPageKind {
  if (parsedCount > 0) return "results";
  const lower = html.toLowerCase();
  if (DDG_BLOCK_MARKERS.some((marker) => lower.includes(marker))) return "blocked";
  // A no-hit query still renders the results shell, so the shell is what tells
  // "nothing matched" apart from "this is not the page we know how to read".
  if (lower.includes("no-results") || lower.includes("no results found")) return "empty";
  if (DDG_PAGE_MARKERS.some((marker) => lower.includes(marker.toLowerCase()))) return "drift";
  return "drift";
}

/**
 * Parses the DuckDuckGo HTML results page into structured results, without a
 * DOM dependency. Each result row carries a `result__a` anchor (title + href)
 * and a `result__snippet` element. Robust to markup drift: anything it cannot
 * parse is skipped, so a changed layout yields [] rather than a throw — see
 * classifySearchPage for telling the reasons apart.
 */
export function parseDdgResults(html: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  // Anchor with class result__a: capture href and inner title text.
  const anchorRe = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null) {
    if (results.length >= limit) break;
    const href = match[1] ?? "";
    const title = decodeEntities(match[2] ?? "");
    const url = decodeDdgUrl(href);
    if (!url || !title) continue;
    if (seen.has(url)) continue;
    // Snippet: the next result__snippet element after this anchor, if any.
    const after = html.slice(anchorRe.lastIndex);
    const snippetMatch =
      /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(after) ??
      /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|td)>/i.exec(after);
    const snippet = snippetMatch ? decodeEntities(snippetMatch[1] ?? "") : "";
    seen.add(url);
    results.push({ title, url, snippet });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Search backends.
//
// web_search had exactly one: DuckDuckGo's HTML page, scraped. That is a single
// point of failure with no way around it — when DDG changes its markup or
// serves a block page, every search in every workspace returns nothing, and
// there is no configuration that helps. SearXNG is the second leg: a JSON API,
// no key, and self-hostable, which is the shape that fits a local-first tool.
// ---------------------------------------------------------------------------

/**
 * Per-workspace search configuration.
 *
 * Keyed by workspace for the same reason the vision endpoint is: the server
 * runs several workspaces in one process, and a setting configured for one of
 * them must not become another's. A default (no workspace) exists for the
 * single-workspace frontends.
 */
export type WebSearchConfig = {
  /**
   * Base URL of a SearXNG instance. When set it is tried before DuckDuckGo, so
   * a self-hosted instance is authoritative while the public scrape stays as a
   * backstop.
   */
  searxngUrl?: string;
  /**
   * Brave Search API subscription token. Tried FIRST when present: someone who
   * paid for a search API meant it to be the one that answers, and it is the
   * only leg here that is neither a scrape nor a service the user has to run.
   */
  braveApiKey?: string;
};

/**
 * Turn a frontend's `webSearch` config block into a WebSearchConfig, or
 * undefined when it configures nothing.
 *
 * Shared because three frontends apply the same block and each used to inline
 * the mapping: the second key would otherwise have had to be remembered in
 * three places, which is how the first one ended up honored by the CLI and
 * ignored by the TUI in earlier rounds of this repository.
 */
export function resolveWebSearchConfig(
  input: { searxngUrl?: string; braveApiKey?: string } | undefined,
): WebSearchConfig | undefined {
  const searxngUrl = input?.searxngUrl?.trim();
  const braveApiKey = input?.braveApiKey?.trim();
  if (!searxngUrl && !braveApiKey) return undefined;
  return {
    ...(searxngUrl ? { searxngUrl } : {}),
    ...(braveApiKey ? { braveApiKey } : {}),
  };
}

const searchConfigs = new Map<string, WebSearchConfig>();
let defaultSearchConfig: WebSearchConfig | undefined;

/** Set (or clear, with undefined) the search config for one workspace. */
export function configureWebSearch(config: WebSearchConfig | undefined, workspace?: string): void {
  if (workspace === undefined) {
    defaultSearchConfig = config;
    return;
  }
  if (config === undefined) searchConfigs.delete(workspace);
  else searchConfigs.set(workspace, config);
}

function searchConfigFor(workspace: string | undefined): WebSearchConfig {
  if (workspace !== undefined) {
    const scoped = searchConfigs.get(workspace);
    if (scoped) return scoped;
  }
  return defaultSearchConfig ?? {};
}

/** One backend's answer: rows, plus why there were none. */
type BackendOutcome = { kind: SearchPageKind; results: WebSearchResult[] };

async function fetchSearchBody(
  url: URL,
  signal: AbortSignal | undefined,
  headers: Record<string, string> = {},
): Promise<string> {
  const controller = new AbortController();
  const offAbort = onAbortOnce(signal, () => controller.abort());
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "seekforge-agent", ...headers },
    });
    if (!res.ok) throw new ToolError("search_failed", `Search failed: HTTP ${res.status}`);
    return (await readResponseBody(res)).toString("utf8");
  } finally {
    offAbort();
    clearTimeout(timer);
  }
}

async function searchDuckDuckGo(query: string, count: number, signal?: AbortSignal): Promise<BackendOutcome> {
  const url = new URL(DDG_HTML_ENDPOINT);
  url.searchParams.set("q", query);
  const html = await fetchSearchBody(url, signal);
  const results = parseDdgResults(html, count);
  return { kind: classifySearchPage(html, results.length), results };
}

/**
 * Parse a SearXNG `format=json` response. Same defensive posture as the HTML
 * parser: anything unrecognized is skipped rather than thrown, and every URL
 * goes through the same http(s)-only filter the DDG path uses, because a
 * self-hosted instance can still be fed a hostile result by an upstream engine.
 */
export function parseSearxngResults(body: string, limit: number): WebSearchResult[] {
  return searxngOutcome(body, limit).results;
}

/**
 * Whether this body was a SearXNG answer at all, and what it said.
 *
 * `results` being an empty ARRAY is the instance saying the query matched
 * nothing; `results` being absent means this parser no longer understands the
 * response. Deciding it by "did the body start with a brace" — which is what
 * this used to do — reports a renamed field, an error envelope, or an instance
 * answering `{"detail":"..."}` as a confident "no such thing exists".
 */
export function searxngOutcome(body: string, limit: number): BackendOutcome {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { kind: "drift", results: [] };
  }
  if (typeof payload !== "object" || payload === null) return { kind: "drift", results: [] };
  const rows = (payload as { results?: unknown }).results;
  if (!Array.isArray(rows)) return { kind: "drift", results: [] };
  const results = searxngRows(rows, limit);
  return { kind: results.length > 0 ? "results" : "empty", results };
}

function searxngRows(rows: unknown[], limit: number): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (out.length >= limit) break;
    if (typeof row !== "object" || row === null) continue;
    const { url, title, content } = row as { url?: unknown; title?: unknown; content?: unknown };
    if (typeof url !== "string" || typeof title !== "string" || title.trim() === "") continue;
    const safe = decodeDdgUrl(url); // http(s)-only, same filter as the DDG path
    if (!safe || seen.has(safe)) continue;
    seen.add(safe);
    out.push({ title: title.trim(), url: safe, snippet: typeof content === "string" ? content.trim() : "" });
  }
  return out;
}

async function searchSearxng(
  baseUrl: string,
  query: string,
  count: number,
  signal?: AbortSignal,
): Promise<BackendOutcome> {
  const url = new URL("./search", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const body = await fetchSearchBody(url, signal);
  return searxngOutcome(body, count);
}

/**
 * Parse a Brave Search API response (`web.results[]`).
 *
 * Same posture as the other parsers: unrecognized rows are skipped rather than
 * thrown, and every URL goes through the http(s)-only filter — a search API is
 * still returning URLs chosen by someone else.
 */
export function parseBraveResults(body: string, limit: number): WebSearchResult[] {
  return braveOutcome(body, limit).results;
}

/**
 * Whether this body was a Brave answer at all, and what it said.
 *
 * The distinction is the whole point of the classification: `web.results` being
 * an empty ARRAY is Brave telling us the query matched nothing, while
 * `web.results` being absent means this parser no longer understands Brave's
 * response — and those two call for opposite actions. Deciding it by "did we
 * get any rows" would report a renamed field as a confident "no such thing
 * exists", which is exactly what the `drift` outcome exists to prevent.
 */
export function braveOutcome(body: string, limit: number): BackendOutcome {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { kind: "drift", results: [] };
  }
  if (typeof payload !== "object" || payload === null) return { kind: "drift", results: [] };
  const rows = (payload as { web?: { results?: unknown } }).web?.results;
  if (!Array.isArray(rows)) return { kind: "drift", results: [] };
  const results = braveRows(rows, limit);
  return { kind: results.length > 0 ? "results" : "empty", results };
}

function braveRows(rows: unknown[], limit: number): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (out.length >= limit) break;
    if (typeof row !== "object" || row === null) continue;
    const { url, title, description } = row as { url?: unknown; title?: unknown; description?: unknown };
    if (typeof url !== "string" || typeof title !== "string") continue;
    // Brave marks the query terms with <strong> in both fields — the same
    // decodeEntities the DuckDuckGo path uses strips the tags and the entities.
    // A title that is only markup leaves nothing to show, so it is skipped here
    // rather than after the URL is claimed as seen.
    const cleanTitle = decodeEntities(title);
    if (cleanTitle === "") continue;
    const safe = decodeDdgUrl(url); // http(s)-only, same filter as every other path
    if (!safe || seen.has(safe)) continue;
    seen.add(safe);
    out.push({
      title: cleanTitle,
      url: safe,
      snippet: typeof description === "string" ? decodeEntities(description) : "",
    });
  }
  return out;
}

async function searchBrave(
  apiKey: string,
  query: string,
  count: number,
  signal?: AbortSignal,
): Promise<BackendOutcome> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  // No accept-encoding here on purpose. Brave's docs suggest sending `gzip`,
  // but fetch negotiates and decompresses on its own, and setting the header by
  // hand is the kind of thing that gets a compressed body handed back
  // undecoded — which would parse to zero rows and read as "the search ran and
  // found nothing", the exact failure this backend exists to avoid.
  const body = await fetchSearchBody(url, signal, {
    accept: "application/json",
    "x-subscription-token": apiKey,
  });
  return braveOutcome(body, count);
}

/** How each outcome reads to the model — the reason it got nothing, or the caveat. */
const SEARCH_NOTES: Record<SearchPageKind, string> = {
  results: "Web snippets — verify by fetching the page with web_fetch; not authoritative.",
  empty: "No results: the search ran and the query matched nothing. Try different keywords.",
  drift:
    "The search did NOT run: the provider answered with a page this parser does not recognize (its markup likely changed). Do not read this as 'no such thing exists'.",
  blocked:
    "The search did NOT run: the provider served a block/captcha page instead of results. Do not read this as 'no such thing exists'.",
};

const SEARCH_DEFAULT_COUNT = 5;
const SEARCH_MAX_COUNT = 10;

const webSearchSchema = z.object({
  query: z.string().min(1).describe("Search query: a few concrete keywords, not a full sentence."),
  count: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_MAX_COUNT)
    .optional()
    .describe(`Number of results to return (default ${SEARCH_DEFAULT_COUNT}, max ${SEARCH_MAX_COUNT}).`),
});

const webSearch = defineTool({
  name: "web_search",
  description:
    "Search the web (DuckDuckGo) with query and return top results as {title, url, snippet}. " +
    "Every search requires user confirmation (network is off by default), so search only for facts you cannot get locally: current library versions, unfamiliar error messages, recent API changes. " +
    'Use a few concrete keywords ("vitest mock timers flush"), not full sentences; snippets are leads, not authoritative — verify with web_fetch.',
  schema: webSearchSchema,
  // "env" level: always confirmed even in auto mode, like web_fetch — the
  // network is default-deny and the raw query is shown to the user.
  classify: (args) => ({
    permission: "env",
    description: `Web search: ${args.query}`,
    command: `SEARCH ${args.query}`,
  }),
  async run(args, ctx) {
    const count = Math.min(args.count ?? SEARCH_DEFAULT_COUNT, SEARCH_MAX_COUNT);
    const { searxngUrl, braveApiKey } = searchConfigFor(ctx.workspace);

    // Most authoritative first: a paid API, then a self-hosted instance, then
    // the public scrape as the backstop that is always there. Only a backend
    // that did NOT run (drift/block) hands over — a search that ran and matched
    // nothing is an answer, and asking a second provider to disagree with it
    // would just launder "no hits" into noise.
    const chain: { name: string; run: () => Promise<BackendOutcome> }[] = [];
    if (braveApiKey !== undefined && braveApiKey.trim() !== "") {
      chain.push({ name: "brave", run: () => searchBrave(braveApiKey, args.query, count, ctx.signal) });
    }
    if (searxngUrl !== undefined && searxngUrl.trim() !== "") {
      chain.push({ name: "searxng", run: () => searchSearxng(searxngUrl, args.query, count, ctx.signal) });
    }
    chain.push({ name: "duckduckgo", run: () => searchDuckDuckGo(args.query, count, ctx.signal) });

    const attempted: string[] = [];
    let outcome: BackendOutcome | undefined;
    let lastError: unknown;
    for (const backend of chain) {
      attempted.push(backend.name);
      try {
        outcome = await backend.run();
      } catch (err) {
        if (ctx.signal?.aborted) throw new ToolError("cancelled", "Web search cancelled");
        lastError = err;
        outcome = undefined;
        continue; // a backend that threw is a backend that did not answer
      }
      if (outcome.kind === "results" || outcome.kind === "empty") break;
    }

    if (!outcome) {
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      throw new ToolError("search_failed", `Search failed (${attempted.join(", ")}): ${message}`);
    }

    const results = outcome.results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: redactSecrets(r.snippet),
    }));
    // The provider list is reported so "the search did not run" is attributable
    // rather than a mystery.
    const note =
      chain.length > 1 ? `${SEARCH_NOTES[outcome.kind]} (tried: ${attempted.join(", ")})` : SEARCH_NOTES[outcome.kind];
    return { data: { results, note, searched: outcome.kind !== "drift" && outcome.kind !== "blocked" } };
  },
});

export const webTools: ToolSpec[] = [webFetch, webSearch];
