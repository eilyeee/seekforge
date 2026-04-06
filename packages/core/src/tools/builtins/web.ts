import { z } from "zod";
import { DEFAULT_LIMITS } from "@seekforge/shared";
import { ToolError } from "../errors.js";
import { redactSecrets } from "../redact.js";
import { truncateHeadTail } from "../text.js";
import { defineTool, type ToolSpec } from "../registry.js";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1_000_000;

/**
 * SSRF guard: refuse non-http(s) schemes and private/loopback/link-local
 * targets — the agent must not be able to probe the local network.
 */
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
  // IPv6 hostnames keep their brackets in WHATWG URLs — strip for matching.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isPrivate =
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^127\./.test(host) ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.startsWith("fe80:") || // IPv6 link-local
    host.startsWith("fc") || // IPv6 unique-local fc00::/7
    host.startsWith("fd") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host);
  if (isPrivate) {
    throw new ToolError("private_address", `Refusing to fetch a private/loopback address: ${host}`);
  }
  return url;
}

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
});

const webFetch = defineTool({
  name: "web_fetch",
  description:
    "Fetch a public http(s) URL and return its readable text (HTML is stripped). Every fetch requires user confirmation; private/loopback addresses are refused.",
  schema: webFetchSchema,
  // "env" level: always confirmed, even in auto-approval mode — the network
  // is off by default (docs/14 §3.5) and every URL is shown raw to the user.
  classify: (args) => ({
    permission: "env",
    description: `Fetch URL: ${args.url}`,
    command: `GET ${args.url}`,
  }),
  async run(args, _ctx) {
    const url = checkFetchUrl(args.url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: { "user-agent": "seekforge-agent" },
      });
    } catch (err) {
      throw new ToolError(
        "fetch_failed",
        `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!/text\/|json|xml|javascript/i.test(contentType)) {
      throw new ToolError("unsupported_content", `Unsupported content-type: ${contentType || "unknown"}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BODY_BYTES) {
      throw new ToolError("too_large", `Response body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    let text = buf.toString("utf8");
    if (/text\/html/i.test(contentType)) text = htmlToText(text);

    const { text: capped, truncated } = truncateHeadTail(text, DEFAULT_LIMITS.toolOutputMaxChars);
    return {
      data: {
        url: args.url,
        status: res.status,
        contentType,
        content: redactSecrets(capped),
      },
      meta: { truncated },
    };
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
 * Parses the DuckDuckGo HTML results page into structured results, without a
 * DOM dependency. Each result row carries a `result__a` anchor (title + href)
 * and a `result__snippet` element. Robust to markup drift: anything it cannot
 * parse is skipped, so a changed layout yields [] rather than a throw.
 */
export function parseDdgResults(html: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  // Anchor with class result__a: capture href and inner title text.
  const anchorRe =
    /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
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

const SEARCH_DEFAULT_COUNT = 5;
const SEARCH_MAX_COUNT = 10;

const webSearchSchema = z.object({
  query: z.string().min(1).describe("Search query text."),
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
    "Search the web via DuckDuckGo and return the top results (title, url, snippet). " +
    "Results are web snippets to verify by fetching the page — not authoritative. " +
    "Every search requires user confirmation (the network is off by default).",
  schema: webSearchSchema,
  // "env" level: always confirmed even in auto mode, like web_fetch — the
  // network is default-deny and the raw query is shown to the user.
  classify: (args) => ({
    permission: "env",
    description: `Web search: ${args.query}`,
    command: `SEARCH ${args.query}`,
  }),
  async run(args, _ctx) {
    const count = Math.min(args.count ?? SEARCH_DEFAULT_COUNT, SEARCH_MAX_COUNT);
    const url = new URL(DDG_HTML_ENDPOINT);
    url.searchParams.set("q", args.query);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
        headers: { "user-agent": "seekforge-agent" },
      });
    } catch (err) {
      throw new ToolError(
        "search_failed",
        `Search failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new ToolError("search_failed", `Search failed: HTTP ${res.status}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BODY_BYTES) {
      throw new ToolError("search_failed", `Search response exceeds ${MAX_BODY_BYTES} bytes`);
    }
    const html = buf.toString("utf8");

    const parsed = parseDdgResults(html, count);
    const results = parsed.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: redactSecrets(r.snippet),
    }));

    // Markup drift / zero hits: return empty with a note instead of throwing.
    if (results.length === 0) {
      return {
        data: {
          results: [],
          note: "No results parsed — the query may have no hits or DuckDuckGo's markup changed.",
        },
      };
    }
    return {
      data: {
        results,
        note: "Web snippets — verify by fetching the page with web_fetch; not authoritative.",
      },
    };
  },
});

export const webTools: ToolSpec[] = [webFetch, webSearch];
