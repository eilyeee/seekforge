import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { ToolError } from "../errors.js";
import { resolveForWrite } from "../sandbox.js";
import { defineTool, type ToolSpec } from "../registry.js";
import { checkFetchUrl } from "./web.js";

/**
 * Browser / visual verification tools, backed by Playwright.
 *
 * Playwright is an OPTIONAL dependency: it is imported dynamically (never at the
 * top level) so typecheck/build/tests all pass with it absent. The import
 * specifier is a variable so TypeScript does not statically resolve the module
 * (it would otherwise error when the dep is not installed), and a missing module
 * surfaces as an actionable `browser_unavailable` error rather than a crash.
 *
 * A single headless browser + page is shared across the four tools (navigate →
 * screenshot / snapshot / console) so the agent can run a "verify a frontend
 * change" loop against one live page. Agent runs retain the instance through
 * `acquireBrowserLease()`; the final release tears it down. A process-exit
 * fallback ensures a headless browser process is never leaked.
 */

const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;
// Bound the capture buffers so a chatty page cannot grow them without limit.
const MAX_CAPTURED = 200;
const MAX_SNAPSHOT_CHARS = 12_000;
const MAX_ELEMENTS = 100;

const INSTALL_HINT =
  "browser tools need Playwright: pnpm add -w playwright-core && npx playwright install chromium";

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
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || /^127\./.test(host)) return url;
  return checkFetchUrl(raw);
}

// Minimal structural types for the Playwright surface this file touches. The
// dependency is optional and may be absent at type-check time, so these mirror
// exactly the members we call instead of importing playwright's own types.
type PlaywrightRequest = { url(): string; failure(): { errorText: string } | null };
type PlaywrightRoute = {
  request(): PlaywrightRequest;
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
};
type PlaywrightConsoleMessage = { type(): string; text(): string };
type PlaywrightResponse = { status(): number };
type PlaywrightPage = {
  on(event: "console", cb: (msg: PlaywrightConsoleMessage) => void): void;
  on(event: "pageerror", cb: (err: Error) => void): void;
  on(event: "requestfailed", cb: (req: PlaywrightRequest) => void): void;
  goto(url: string, opts?: { waitUntil?: "load"; timeout?: number }): Promise<PlaywrightResponse | null>;
  title(): Promise<string>;
  url(): string;
  screenshot(opts?: { path?: string; fullPage?: boolean; timeout?: number }): Promise<unknown>;
  evaluate<Arg, R>(fn: (arg: Arg) => R, arg: Arg): Promise<R>;
};
type PlaywrightContext = {
  newPage(): Promise<PlaywrightPage>;
  route(pattern: string, handler: (route: PlaywrightRoute) => Promise<void>): Promise<void>;
};
type PlaywrightBrowser = {
  newContext(opts?: unknown): Promise<PlaywrightContext>;
  close(): Promise<void>;
};
type PlaywrightModule = {
  chromium: { launch(opts?: { headless?: boolean }): Promise<PlaywrightBrowser> };
};

type ConsoleEntry = { type: string; text: string };
type FailedRequest = { url: string; failure: string };

let browser: PlaywrightBrowser | null = null;
let context: PlaywrightContext | null = null;
let page: PlaywrightPage | null = null;
const browserLeases = new Set<symbol>();

// Capture buffers, reset on every navigate so `browser_console` reports only
// what happened since the current page loaded.
let consoleMessages: ConsoleEntry[] = [];
let pageErrors: string[] = [];
let failedRequests: FailedRequest[] = [];

/**
 * Dynamically import `playwright-core`. The specifier is held in a variable so
 * TypeScript does not statically resolve it (the optional dep may be absent at
 * compile time). A missing module becomes an actionable ToolError.
 */
async function loadPlaywright(): Promise<PlaywrightModule> {
  const specifier = "playwright-core";
  try {
    return (await import(specifier)) as PlaywrightModule;
  } catch {
    throw new ToolError("browser_unavailable", INSTALL_HINT);
  }
}

/** Launch (or reuse) the shared headless browser + page, attaching listeners. */
async function getPage(): Promise<PlaywrightPage> {
  const pw = await loadPlaywright();
  if (!browser) {
    browser = await pw.chromium.launch({ headless: true });
    installExitHook();
  }
  if (!context) {
    context = await browser.newContext();
    // Re-check every navigation/subresource so a public URL cannot redirect the
    // browser into an unapproved private network target.
    await context.route("**/*", async (route) => {
      try {
        checkBrowserUrl(String(route.request().url()));
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
  }
  if (!page) {
    page = await context.newPage();
    // Attach capture listeners once per page; buffers are reset on navigate.
    page.on("console", (msg) => {
      if (consoleMessages.length < MAX_CAPTURED) {
        consoleMessages.push({ type: String(msg.type?.() ?? "log"), text: String(msg.text?.() ?? "") });
      }
    });
    page.on("pageerror", (err) => {
      if (pageErrors.length < MAX_CAPTURED) pageErrors.push(err?.message ? String(err.message) : String(err));
    });
    page.on("requestfailed", (req) => {
      if (failedRequests.length < MAX_CAPTURED) {
        failedRequests.push({ url: String(req.url?.() ?? ""), failure: String(req.failure?.()?.errorText ?? "failed") });
      }
    });
  }
  return page;
}

/** True once a page has been navigated (the inspect tools need a live page). */
function requirePage(): PlaywrightPage {
  if (!page) {
    throw new ToolError("no_page", "No page loaded — call browser_navigate first.");
  }
  return page;
}

/**
 * Force-close the shared browser and invalidate all leases. Normal agent-run
 * cleanup releases its BrowserLease instead.
 */
export async function disposeBrowser(): Promise<void> {
  browserLeases.clear();
  await closeBrowser();
}

async function closeBrowser(): Promise<void> {
  const b = browser;
  browser = null;
  context = null;
  page = null;
  consoleMessages = [];
  pageErrors = [];
  failedRequests = [];
  if (b) {
    try {
      await b.close();
    } catch {
      // Best-effort teardown — a failed close must not surface as an error.
    }
  }
}

export type BrowserLease = {
  /** Release this run's ownership. The final active release closes the browser. */
  release(): Promise<void>;
};

/** Retain the shared browser for one top-level agent run. */
export function acquireBrowserLease(): BrowserLease {
  const token = Symbol("browser-lease");
  browserLeases.add(token);
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      if (!browserLeases.delete(token) || browserLeases.size > 0) return;
      await closeBrowser();
    },
  };
}

let exitHookInstalled = false;
/**
 * Best-effort fallback so a headless browser process is not leaked if the app
 * exits without calling disposeBrowser(). Registered lazily, only after a
 * browser is actually launched, so runs that never use these tools add no
 * listeners. The primary teardown path is the final BrowserLease release.
 */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const close = (): void => {
    void disposeBrowser();
  };
  process.once("beforeExit", close);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.once("exit", close);
}

const navigateSchema = z.object({
  url: z.string().describe("Absolute http(s) url to open in a headless browser (e.g. your dev server)."),
});

const browserNavigate = defineTool({
  name: "browser_navigate",
  description:
    "Open an absolute http(s) url in a shared headless browser so you can verify a frontend change; reuses one browser+page across calls. " +
    "Returns the final url, HTTP status, and page title, and starts capturing console/errors/failed-requests for browser_console. " +
    "Outward network action — always requires user confirmation. Loopback dev servers are allowed; other private addresses are refused.",
  schema: navigateSchema,
  // "env" level: always confirmed even in auto mode, like web_fetch — this
  // takes an outward network action and the raw url is shown to the user.
  classify: (args) => ({
    permission: "env",
    description: `Open in browser: ${args.url}`,
    command: `GET ${args.url}`,
  }),
  async run(args) {
    const url = checkBrowserUrl(args.url);
    const p = await getPage();
    // Reset capture so browser_console reflects only the new page.
    consoleMessages = [];
    pageErrors = [];
    failedRequests = [];
    let resp: PlaywrightResponse | null;
    try {
      resp = await p.goto(url.toString(), { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      throw new ToolError(
        "navigation_failed",
        `Navigation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const title = await p.title().catch(() => "");
    return {
      data: {
        url: p.url(),
        status: resp?.status?.() ?? null,
        title,
      },
    };
  },
});

const screenshotSchema = z.object({
  path: z
    .string()
    .optional()
    .describe(
      "Optional workspace-relative path for the PNG (default: .seekforge/uploads/screenshot-<ts>.png).",
    ),
});

const browserScreenshot = defineTool({
  name: "browser_screenshot",
  description:
    "Capture a full-page PNG of the currently loaded browser page and save it under the workspace (default .seekforge/uploads/, or a given path); returns the saved path. " +
    "Read-only on the page — call browser_navigate first. Pass the path to image_analyze to inspect it visually.",
  schema: screenshotSchema,
  // Writes a PNG artifact into the workspace but takes no new outward action;
  // classify as "execute" (the page was already loaded via a confirmed navigate).
  classify: (args) => ({
    permission: "execute",
    description: "Screenshot the current browser page",
    ...(args.path !== undefined ? { path: args.path } : {}),
  }),
  async run(args, ctx) {
    await loadPlaywright();
    const p = requirePage();
    const rel = args.path ?? path.join(".seekforge", "uploads", `screenshot-${Date.now()}.png`);
    const resolved = resolveForWrite(ctx.workspace, rel);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    try {
      await p.screenshot({ path: resolved, fullPage: true, timeout: ACTION_TIMEOUT_MS });
    } catch (err) {
      throw new ToolError(
        "screenshot_failed",
        `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { data: { path: rel } };
  },
});

const browserSnapshot = defineTool({
  name: "browser_snapshot",
  description:
    "Return a concise text snapshot of the currently loaded browser page (title, url, headings, links, buttons, inputs, and visible text) so you can 'see' it without an image. " +
    "Read-only — call browser_navigate first.",
  schema: z.object({}),
  // Pure read of the already-loaded page.
  classify: () => ({ permission: "readonly", description: "Snapshot the current browser page" }),
  async run() {
    await loadPlaywright();
    const p = requirePage();
    // Extract a compact accessibility-ish summary in the page context. DOM
    // globals are reached through globalThis so this typechecks without the
    // "dom" lib (the body runs in the browser, not in Node).
    const snap = (await p.evaluate((max: number) => {
      const g = globalThis as any;
      const doc = g.document;
      const textOf = (el: any): string => (el.textContent ?? "").replace(/\s+/g, " ").trim();
      const take = (arr: any[]): any[] => arr.slice(0, max);
      const headings = take(Array.from(doc.querySelectorAll("h1,h2,h3")))
        .map((el) => `${el.tagName.toLowerCase()}: ${textOf(el)}`)
        .filter((s) => s.length > 4);
      const links = take(Array.from(doc.querySelectorAll("a[href]")))
        .map((el) => textOf(el))
        .filter(Boolean);
      const buttons = take(
        Array.from(doc.querySelectorAll("button, [role=button], input[type=submit], input[type=button]")),
      )
        .map((el) => textOf(el) || el.value || "")
        .filter(Boolean);
      const inputs = take(Array.from(doc.querySelectorAll("input, textarea, select"))).map((el) =>
        [el.getAttribute("name"), el.getAttribute("type"), el.getAttribute("placeholder")]
          .filter(Boolean)
          .join(" "),
      );
      const text = (doc.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
      return { title: doc.title, url: g.location.href, headings, links, buttons, inputs, text };
    }, MAX_ELEMENTS)) as {
      title: string;
      url: string;
      headings: string[];
      links: string[];
      buttons: string[];
      inputs: string[];
      text: string;
    };
    const text =
      snap.text.length > MAX_SNAPSHOT_CHARS
        ? snap.text.slice(0, MAX_SNAPSHOT_CHARS) + "\n… [truncated]"
        : snap.text;
    return { data: { ...snap, text } };
  },
});

const browserConsole = defineTool({
  name: "browser_console",
  description:
    "Return console messages, uncaught page errors, and failed network requests captured since the last browser_navigate — the key signal for whether your change broke the page. " +
    "Read-only — call browser_navigate first.",
  schema: z.object({}),
  classify: () => ({ permission: "readonly", description: "Read the current browser page's console" }),
  async run() {
    await loadPlaywright();
    requirePage();
    return {
      data: {
        console: consoleMessages,
        errors: pageErrors,
        failedRequests,
      },
    };
  },
});

export const browserTools: ToolSpec[] = [
  browserNavigate,
  browserScreenshot,
  browserSnapshot,
  browserConsole,
];
