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

export const webTools: ToolSpec[] = [webFetch];
