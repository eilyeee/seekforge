import { existsSync } from "node:fs";
import { ToolError } from "../errors.js";
import { abortablePromise, onAbortOnce } from "../../util/abort.js";
import { installProcessTeardown } from "../../util/process-teardown.js";
import { writeBrowserProfile } from "./profile.js";
import { assertBrowserUrlAllowed, isLoopbackHost } from "./url-guard.js";
import { loadPlaywright, type PlaywrightBrowser, type PlaywrightContext, type PlaywrightPage } from "./playwright.js";

/**
 * The shared headless browser session.
 *
 * One browser + one page is shared across every browser tool, so navigate →
 * inspect → interact → inspect is a single live page the agent can drive, the
 * way a person would. Agent runs retain the instance through
 * `acquireBrowserLease()`; the final release tears it down, and a process-exit
 * fallback ensures a headless browser process is never leaked.
 *
 * This module owns lifecycle and capture only. The tools live next to it and
 * hold no state of their own.
 */

// Bound the capture buffers so a chatty page cannot grow them without limit.
const MAX_CAPTURED = 200;

export type ConsoleEntry = { type: string; text: string };
export type FailedRequest = { url: string; failure: string };
/** One completed request/response pair the page made. */
export type NetworkEntry = { method: string; url: string; status: number; resourceType?: string };

let browser: PlaywrightBrowser | null = null;
let context: PlaywrightContext | null = null;
let page: PlaywrightPage | null = null;
let activeBrowserSignal: AbortSignal | undefined;
const browserLeases = new Set<symbol>();

/**
 * Where this session loads and stores its cookies, or null for the default:
 * a context that starts logged out and forgets everything when it closes.
 *
 * Module-level for the same reason the vision endpoint is — ToolContext carries
 * no credentials and no user paths, so the app injects this once at assembly
 * time. Nothing the model can call reaches it: the agent cannot decide to start
 * persisting cookies, or to persist them somewhere else.
 */
let storageStatePath: string | null = null;

/**
 * Configure browser-session persistence. Call once at app assembly time with an
 * absolute path (see resolveBrowserProfilePath), or null to keep every run
 * ephemeral. Off by default: a stored session is a stored login.
 */
export function configureBrowserProfile(path: string | null): void {
  storageStatePath = path;
}

// Capture buffers, reset on every navigate so `browser_console` reports only
// what happened since the current page loaded. Interactions deliberately do NOT
// reset them: a click that triggers an error should still be visible afterwards.
let consoleMessages: ConsoleEntry[] = [];
let pageErrors: string[] = [];
let failedRequests: FailedRequest[] = [];
let networkResponses: NetworkEntry[] = [];

/** Launch (or reuse) the shared headless browser + page, attaching listeners. */
export async function getPage(): Promise<PlaywrightPage> {
  const pw = await loadPlaywright();
  if (!browser) {
    browser = await pw.chromium.launch({ headless: true });
    installExitHook();
  }
  if (!context) {
    // A configured profile that does not exist yet is the normal first run, not
    // an error — Playwright would throw on a missing storageState file, so the
    // absence is checked here and the context simply starts logged out.
    const restore = storageStatePath !== null && existsSync(storageStatePath);
    context = await browser.newContext(restore ? { storageState: storageStatePath } : undefined);
    // Re-check every navigation/subresource so a public URL cannot redirect the
    // browser into an unapproved private network target. This validates the
    // request host with a DNS lookup, but unlike web_fetch it cannot PIN the
    // socket: Chromium re-resolves the host itself on `continue()`, so a TTL-0
    // rebinding attacker could still race a private answer into the connect.
    // Playwright exposes no per-navigation resolver override to close that
    // window; browser_navigate is an always-confirmed ("env") action, which is
    // the compensating control for this residual risk.
    await context.route("**/*", async (route) => {
      try {
        await assertBrowserUrlAllowed(String(route.request().url()), undefined, activeBrowserSignal);
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
    // A request that COMPLETED is the half the console never shows: a 500 from
    // an XHR leaves no console message and no page error, so a run watching
    // only those reports a page that "loaded fine" while its data call failed.
    page.on("response", (res) => {
      if (networkResponses.length >= MAX_CAPTURED) return;
      try {
        const request = res.request?.();
        networkResponses.push({
          method: String(request?.method?.() ?? "GET"),
          url: String(res.url?.() ?? ""),
          status: Number(res.status?.() ?? 0),
          ...(request?.resourceType ? { resourceType: String(request.resourceType()) } : {}),
        });
      } catch {
        // A response object can outlive its page during teardown; a capture
        // buffer is never worth failing a tool call over.
      }
    });
    page.on("requestfailed", (req) => {
      if (failedRequests.length < MAX_CAPTURED) {
        failedRequests.push({
          url: String(req.url?.() ?? ""),
          failure: String(req.failure?.()?.errorText ?? "failed"),
        });
      }
    });
  }
  return page;
}

/** The live page; every tool but browser_navigate needs one to already exist. */
export function requirePage(): PlaywrightPage {
  if (!page) {
    throw new ToolError("no_page", "No page loaded — call browser_navigate first.");
  }
  return page;
}

/**
 * The current page's URL, or undefined when no page is loaded. Synchronous, so
 * `classify` can decide a permission level from where the page actually points.
 */
export function currentPageUrl(): string | undefined {
  if (!page) return undefined;
  try {
    return page.url();
  } catch {
    return undefined;
  }
}

/** True when the loaded page is the developer's own machine. */
export function currentPageIsLoopback(): boolean {
  const url = currentPageUrl();
  if (!url) return false;
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Drop everything captured so far; called when a navigation loads a new page. */
export function resetCapture(): void {
  consoleMessages = [];
  pageErrors = [];
  failedRequests = [];
  networkResponses = [];
}

export function capturedActivity(): {
  console: ConsoleEntry[];
  errors: string[];
  failedRequests: FailedRequest[];
  network: NetworkEntry[];
} {
  return { console: consoleMessages, errors: pageErrors, failedRequests, network: networkResponses };
}

/**
 * Run one Playwright call under the agent's cancellation signal. An abort tears
 * the browser down rather than leaving a half-finished action on a live page.
 */
export async function runBrowserOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  label: string,
): Promise<T> {
  activeBrowserSignal = signal;
  // Cancellation does not persist the session — see closeBrowser.
  const offAbort = onAbortOnce(signal, () => void closeBrowser(false));
  try {
    return await abortablePromise(operation, signal, () => new ToolError("cancelled", `${label} cancelled`));
  } finally {
    offAbort();
    if (activeBrowserSignal === signal) activeBrowserSignal = undefined;
  }
}

/**
 * Force-close the shared browser and invalidate all leases. Normal agent-run
 * cleanup releases its BrowserLease instead.
 */
export async function disposeBrowser(): Promise<void> {
  browserLeases.clear();
  await closeBrowser();
}

/**
 * The teardown in flight, if any.
 *
 * Teardown nulls the module state synchronously and then awaits — a CDP round
 * trip for the session state, then the browser close. Without this, a second
 * caller arriving during that window sees `browser === null`, concludes there
 * is nothing to do, and returns immediately: the run's cleanup would report
 * "browser released" while the profile write was still in flight, and a process
 * that exited right after would lose it. Everyone joins the same promise
 * instead.
 */
let teardown: Promise<void> | null = null;

/**
 * Close the shared browser.
 *
 * `persist` decides whether the session is written to the configured profile.
 * A cancelled run passes false, and that is a deliberate answer to a question
 * with two defensible sides: stopping mid-flow — halfway through a login
 * redirect, just after a cookie rotated — would otherwise overwrite a good
 * saved login with a broken one. Cancel means "forget what I was doing", so the
 * last successfully finished run stays the one on disk.
 */
function closeBrowser(persist = true): Promise<void> {
  if (teardown) return teardown;
  const b = browser;
  const ctx = context;
  browser = null;
  context = null;
  page = null;
  resetCapture();
  if (!b && !ctx) return Promise.resolve();
  teardown = (async () => {
    // While the context still exists. A failure must not become a tool error —
    // teardown runs on the cancellation path too — but it must not be silent
    // either, or the next run would start logged out with no explanation.
    if (persist && ctx && storageStatePath !== null) {
      try {
        writeBrowserProfile(await ctx.storageState(), storageStatePath);
      } catch (error) {
        console.error(
          `[browser] could not save the session profile (${storageStatePath}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (b) {
      try {
        await b.close();
      } catch {
        // Best-effort teardown — a failed close must not surface as an error.
      }
    }
  })().finally(() => {
    teardown = null;
  });
  return teardown;
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
  installProcessTeardown({
    onSignal: () => void disposeBrowser(),
    // 'exit' cannot await the async close — the previous hook registered it
    // anyway, so a hard exit silently leaked the headless browser. Kill the
    // underlying child process synchronously instead.
    onExit: () => {
      try {
        browser?.process?.()?.kill("SIGKILL");
      } catch {
        // best-effort: the process may already be gone
      }
    },
  });
}
