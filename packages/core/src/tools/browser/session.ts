import { existsSync } from "node:fs";
import { ToolError } from "../errors.js";
import { abortablePromise, onAbortOnce } from "../../util/abort.js";
import { installProcessTeardown } from "../../util/process-teardown.js";
import { writeBrowserProfile } from "./profile.js";
import { assertBrowserUrlAllowed, isLoopbackHost } from "./url-guard.js";
import { loadPlaywright, type PlaywrightBrowser, type PlaywrightContext, type PlaywrightPage } from "./playwright.js";

/**
 * The headless browser session — one per WORKSPACE.
 *
 * One browser + one page is shared across every browser tool of a workspace, so
 * navigate → inspect → interact → inspect is a single live page the agent can
 * drive, the way a person would.
 *
 * The workspace keying is the part that is easy to get wrong, and was: browser,
 * context, page and the capture buffers used to be plain module variables. A
 * CLI or TUI process serves one workspace and never noticed. The server serves
 * many and runs them AT ONCE — its locks serialize per repository, so two
 * workspaces execute their agent loops simultaneously — and they shared one
 * page. Workspace B's snapshot read whatever workspace A had open, B's navigate
 * wiped the console evidence A had just captured, and either could steer the
 * other's page mid-flow. The LSP session one import away had been keyed by
 * workspace all along.
 *
 * What is shared and what is not follows from what each thing costs and what it
 * exposes. The browser PROCESS is shared: launching Chromium is expensive and a
 * process leaks nothing by itself. The CONTEXT is per workspace, which is
 * exactly what Playwright's contexts are for — separate cookies, separate
 * storage, separate pages.
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

/** Everything one workspace owns. The browser process below is shared. */
type WorkspaceSession = {
  context: PlaywrightContext;
  page: PlaywrightPage | null;
  /**
   * Capture buffers, reset on every navigate so `browser_console` reports only
   * what happened since the current page loaded. Interactions deliberately do
   * NOT reset them: a click that triggers an error should still be visible.
   */
  console: ConsoleEntry[];
  errors: string[];
  failedRequests: FailedRequest[];
  network: NetworkEntry[];
  /** Teardown in flight for this workspace, so a second caller joins it. */
  closing: Promise<void> | null;
};

/** The Chromium process. Shared: expensive to launch, and isolating nothing. */
let browser: PlaywrightBrowser | null = null;
const sessions = new Map<string, WorkspaceSession>();
const leases = new Map<string, Set<symbol>>();
/** The signal of the operation currently running, per workspace. */
const activeSignals = new Map<string, AbortSignal | undefined>();
/** How many operations are in flight per workspace (see runBrowserOperation). */
const inFlight = new Map<string, number>();

/**
 * Where each workspace loads and stores its cookies, or absent for the default:
 * a context that starts logged out and forgets everything when it closes.
 *
 * Module-level for the same reason the vision endpoint is — ToolContext carries
 * no credentials and no user paths, so the app injects this once at assembly
 * time. Nothing the model can call reaches it: the agent cannot decide to start
 * persisting cookies, or to persist them somewhere else.
 */
const storageStatePaths = new Map<string, string>();
let defaultStorageStatePath: string | null = null;

/**
 * Configure browser-session persistence. Call at app assembly time with an
 * absolute path (see resolveBrowserProfilePath), or null to keep runs
 * ephemeral. Pass a workspace to scope it — what a host serving more than one
 * must do; omit it for the process-wide default. Off by default: a stored
 * session is a stored login.
 */
export function configureBrowserProfile(path: string | null, workspace?: string): void {
  if (workspace === undefined) {
    defaultStorageStatePath = path;
    if (path === null) storageStatePaths.clear();
    return;
  }
  if (path === null) storageStatePaths.delete(workspace);
  else storageStatePaths.set(workspace, path);
}

/**
 * The profile file this workspace loads from and writes back to.
 *
 * Two workspaces may name the same profile, and that is the point of naming
 * one: "both of these projects use my work login". They then share the file,
 * which means the LAST run to finish writes back — if one of them logged in
 * while the other was also open, the later teardown replaces it. That is how a
 * shared browser profile behaves anywhere, it is atomic (temp file, rename), so
 * the file is never torn — but it is worth knowing before naming two projects
 * the same thing. Give them different names to keep their logins apart.
 */
function storageStatePathFor(workspace: string): string | null {
  return storageStatePaths.get(workspace) ?? defaultStorageStatePath;
}

/**
 * The workspace's session, or undefined when it has none — including while one
 * is tearing down. The entry outlives `closeSession` deliberately (see there),
 * so every reader has to ask for a LIVE one rather than whatever is in the map.
 */
function liveSession(workspace: string): WorkspaceSession | undefined {
  const session = sessions.get(workspace);
  return session && session.closing === null ? session : undefined;
}

/**
 * Openings in flight, per workspace.
 *
 * One workspace can have several callers at once: dispatch_team runs its
 * members concurrently and they all share the workspace string. Creating a
 * context is async, so a plain check-then-act would let two of them each build
 * one, with only the second landing in the map — the first orphaned (never
 * closed, never disposed) and its owner then reading the other's page through
 * every subsequent tool call. Everyone joins the same opening instead.
 */
const opening = new Map<string, Promise<PlaywrightPage>>();

/** Launch (or reuse) this workspace's page, attaching listeners. */
export function getPage(workspace: string): Promise<PlaywrightPage> {
  const inFlight = opening.get(workspace);
  if (inFlight) return inFlight;
  const started = openPage(workspace).finally(() => {
    if (opening.get(workspace) === started) opening.delete(workspace);
  });
  opening.set(workspace, started);
  return started;
}

async function openPage(workspace: string): Promise<PlaywrightPage> {
  // A session mid-teardown is finished first: reusing its context would race
  // the close, and starting a second one behind its back would leak it.
  const closing = sessions.get(workspace)?.closing;
  if (closing) await closing;
  const pw = await loadPlaywright();
  if (!browser) {
    browser = await pw.chromium.launch({ headless: true });
    installExitHook();
  }
  let session = liveSession(workspace);
  if (!session) {
    // A configured profile that does not exist yet is the normal first run, not
    // an error — Playwright would throw on a missing storageState file, so the
    // absence is checked here and the context simply starts logged out.
    const profile = storageStatePathFor(workspace);
    const restore = profile !== null && existsSync(profile);
    const context = await browser.newContext(restore ? { storageState: profile } : undefined);
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
        await assertBrowserUrlAllowed(String(route.request().url()), undefined, activeSignals.get(workspace));
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    session = { context, page: null, console: [], errors: [], failedRequests: [], network: [], closing: null };
    sessions.set(workspace, session);
  }
  if (!session.page) {
    const page = await session.context.newPage();
    const own = session;
    // Attach capture listeners once per page; buffers are reset on navigate.
    page.on("console", (msg) => {
      if (own.console.length < MAX_CAPTURED) {
        own.console.push({ type: String(msg.type?.() ?? "log"), text: String(msg.text?.() ?? "") });
      }
    });
    page.on("pageerror", (err) => {
      if (own.errors.length < MAX_CAPTURED) own.errors.push(err?.message ? String(err.message) : String(err));
    });
    // A request that COMPLETED is the half the console never shows: a 500 from
    // an XHR leaves no console message and no page error, so a run watching
    // only those reports a page that "loaded fine" while its data call failed.
    page.on("response", (res) => {
      if (own.network.length >= MAX_CAPTURED) return;
      try {
        const request = res.request?.();
        own.network.push({
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
      if (own.failedRequests.length < MAX_CAPTURED) {
        own.failedRequests.push({
          url: String(req.url?.() ?? ""),
          failure: String(req.failure?.()?.errorText ?? "failed"),
        });
      }
    });
    session.page = page;
  }
  return session.page;
}

/** This workspace's live page; every tool but browser_navigate needs one. */
export function requirePage(workspace: string): PlaywrightPage {
  const page = liveSession(workspace)?.page;
  if (!page) {
    throw new ToolError("no_page", "No page loaded — call browser_navigate first.");
  }
  return page;
}

/**
 * This workspace's page URL, or undefined when it has no page. Synchronous, so
 * `classify` can decide a permission level from where the page actually points.
 */
export function currentPageUrl(workspace: string): string | undefined {
  const page = liveSession(workspace)?.page;
  if (!page) return undefined;
  try {
    return page.url();
  } catch {
    return undefined;
  }
}

/** True when this workspace's loaded page is the developer's own machine. */
export function currentPageIsLoopback(workspace: string): boolean {
  const url = currentPageUrl(workspace);
  if (!url) return false;
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Drop what this workspace captured; called when a navigation loads a new page. */
export function resetCapture(workspace: string): void {
  const session = liveSession(workspace);
  if (!session) return;
  session.console = [];
  session.errors = [];
  session.failedRequests = [];
  session.network = [];
}

export function capturedActivity(workspace: string): {
  console: ConsoleEntry[];
  errors: string[];
  failedRequests: FailedRequest[];
  network: NetworkEntry[];
} {
  const session = liveSession(workspace);
  if (!session) return { console: [], errors: [], failedRequests: [], network: [] };
  return {
    console: session.console,
    errors: session.errors,
    failedRequests: session.failedRequests,
    network: session.network,
  };
}

/**
 * Run one Playwright call under the agent's cancellation signal. An abort tears
 * THIS WORKSPACE's session down rather than leaving a half-finished action on a
 * live page — and leaves every other workspace's session alone, which is the
 * whole point of the keying.
 */
export async function runBrowserOperation<T>(
  workspace: string,
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  label: string,
): Promise<T> {
  activeSignals.set(workspace, signal);
  inFlight.set(workspace, (inFlight.get(workspace) ?? 0) + 1);
  // Leaving the count has to happen in whichever comes first — the abort
  // handler or the finally — and exactly once. An AbortSignal delivers to every
  // listener SYNCHRONOUSLY, in one call stack, so when a parent cancellation
  // cascades to several siblings of one workspace, all their handlers run
  // before any of their finallys. Decrementing only in the finally would have
  // every one of them read the pre-abort count, conclude a sibling was still
  // working, and skip the teardown — leaving the hung call that prompted the
  // abort exactly as stuck as it was.
  let counted = true;
  const leave = (): number => {
    if (!counted) return inFlight.get(workspace) ?? 0;
    counted = false;
    const remaining = (inFlight.get(workspace) ?? 1) - 1;
    if (remaining <= 0) inFlight.delete(workspace);
    else inFlight.set(workspace, remaining);
    return remaining;
  };
  // Closing the context is how a hung Playwright call gets unstuck — it does
  // not answer an AbortSignal. But this workspace may have siblings mid-call
  // (dispatch_team members share it), and closing under them turns their work
  // into a raw "target closed" failure they did nothing to earn. So the teardown
  // happens only when the aborting call is the last one out; the caller's own
  // promise is already rejected by abortablePromise either way. Cancellation
  // also does not persist the session — see closeSession.
  const offAbort = onAbortOnce(signal, () => {
    if (leave() <= 0) void closeSession(workspace, false);
  });
  try {
    return await abortablePromise(operation, signal, () => new ToolError("cancelled", `${label} cancelled`));
  } finally {
    offAbort();
    leave();
    if (activeSignals.get(workspace) === signal) activeSignals.delete(workspace);
  }
}

/**
 * Force-close every workspace's session and the browser, invalidating all
 * leases. Normal agent-run cleanup releases its BrowserLease instead.
 */
export async function disposeBrowser(): Promise<void> {
  leases.clear();
  // Until the map is empty, not once over a snapshot of it: closing is async,
  // and a caller can open a session while this is awaiting the previous ones —
  // a snapshot would leave that one running and its Chromium page with it. The
  // bound is a backstop against a pathological open/close loop keeping this
  // spinning; disposal is teardown, not a place to hang.
  for (let pass = 0; pass < 10 && sessions.size > 0; pass++) {
    await Promise.all([...sessions.keys()].map((workspace) => closeSession(workspace)));
  }
  await closeBrowserProcess();
}

/**
 * Close one workspace's context.
 *
 * `persist` decides whether its session is written to the configured profile.
 * A cancelled run passes false, and that is a deliberate answer to a question
 * with two defensible sides: stopping mid-flow — halfway through a login
 * redirect, just after a cookie rotated — would otherwise overwrite a good
 * saved login with a broken one. Cancel means "forget what I was doing", so the
 * last successfully finished run stays the one on disk.
 *
 * A teardown already in flight is returned rather than started again: it nulls
 * its state synchronously and then awaits — a CDP round trip for the session
 * state, then the close — so a second caller arriving in that window would
 * otherwise see nothing to do and report "released" while the profile write was
 * still going.
 */
function closeSession(workspace: string, persist = true): Promise<void> {
  const session = sessions.get(workspace);
  if (!session) return Promise.resolve();
  if (session.closing) return session.closing;
  const { context } = session;
  const profile = storageStatePathFor(workspace);
  session.closing = (async () => {
    // While the context still exists. A failure must not become a tool error —
    // teardown runs on the cancellation path too — but it must not be silent
    // either, or the next run would start logged out with no explanation.
    if (persist && profile !== null) {
      try {
        writeBrowserProfile(await context.storageState(), profile);
      } catch (error) {
        console.error(
          `[browser] could not save the session profile (${profile}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    try {
      await context.close();
    } catch {
      // Best-effort teardown — a failed close must not surface as an error.
    }
  })().finally(() => {
    // Only now: the entry had to stay reachable so a second caller arriving
    // mid-teardown could join this promise instead of concluding there was
    // nothing left to wait for and reporting "released" over a write still in
    // flight. `liveSession` is what keeps it invisible to readers meanwhile.
    //
    // By IDENTITY, not by key: a fresh session for the same workspace can have
    // replaced this one while it was closing, and deleting by key would evict
    // the live one — leaving its owner told "no page" and letting
    // closeBrowserProcess see an empty map and kill Chromium under it.
    if (sessions.get(workspace) === session) sessions.delete(workspace);
  });
  return session.closing;
}

/** Close the Chromium process once no workspace is using it. */
async function closeBrowserProcess(): Promise<void> {
  if (sessions.size > 0) return;
  const b = browser;
  browser = null;
  if (!b) return;
  try {
    await b.close();
  } catch {
    // Best-effort teardown — a failed close must not surface as an error.
  }
}

export type BrowserLease = {
  /** Release this run's ownership. The final active release closes the browser. */
  release(): Promise<void>;
};

/**
 * Retain the browser for one top-level agent run of one workspace. The last
 * lease of a workspace closes that workspace's context; the last lease overall
 * closes the browser process.
 */
export function acquireBrowserLease(workspace: string): BrowserLease {
  const token = Symbol("browser-lease");
  let held = leases.get(workspace);
  if (!held) {
    held = new Set();
    leases.set(workspace, held);
  }
  held.add(token);
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      const own = leases.get(workspace);
      if (!own?.delete(token) || own.size > 0) return;
      leases.delete(workspace);
      await closeSession(workspace);
      await closeBrowserProcess();
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
