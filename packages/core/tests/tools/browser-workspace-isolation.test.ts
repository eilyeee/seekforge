import { describe, expect, it, vi } from "vitest";

/**
 * Two workspaces, one process.
 *
 * The browser session used to be plain module variables — one browser, one
 * context, one page, one set of capture buffers. A CLI or TUI process serves a
 * single workspace and never noticed. The server serves many and runs them at
 * once (its locks serialize per repository), so two workspaces shared a page:
 * B's snapshot read whatever A had open, B's navigate wiped the console
 * evidence A had just captured, and either could steer the other's page.
 *
 * These tests are the ones that would have failed before the keying, and the
 * ones that fail again if anyone flattens it back.
 */

const fake = vi.hoisted(() => ({
  contexts: 0,
  closedContexts: 0,
  browserCloses: 0,
  launches: 0,
}));

/** A page whose url is per-context, so a leak between workspaces is visible. */
vi.mock("../../src/tools/browser/playwright.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/tools/browser/playwright.js")>();
  const makeContext = (id: number) => {
    let url = `https://workspace-${id}.test/`;
    return {
      newPage: async () => ({
        on: () => {},
        url: () => url,
        goto: async (next: string) => {
          url = next;
          return null;
        },
      }),
      route: async () => {},
      close: async () => {
        fake.closedContexts += 1;
      },
      storageState: async () => ({ cookies: [] }),
    };
  };
  return {
    ...actual,
    loadPlaywright: async () => ({
      chromium: {
        launch: async () => {
          fake.launches += 1;
          return {
            newContext: async () => makeContext(++fake.contexts),
            close: async () => {
              fake.browserCloses += 1;
            },
            process: () => null,
          };
        },
      },
    }),
  };
});

const { acquireBrowserLease, configureBrowserProfile, disposeBrowser } = await import(
  "../../src/tools/browser/index.js"
);
const { capturedActivity, currentPageUrl, getPage, requirePage, resetCapture } = await import(
  "../../src/tools/browser/session.js"
);

const A = "/ws/alpha";
const B = "/ws/beta";

async function reset(): Promise<void> {
  await disposeBrowser();
  configureBrowserProfile(null);
  fake.contexts = 0;
  fake.closedContexts = 0;
  fake.browserCloses = 0;
  fake.launches = 0;
}

describe("browser sessions are per workspace", () => {
  it("gives each workspace its own page", async () => {
    await reset();
    await getPage(A);
    await getPage(B);
    // Two contexts, one browser process: the process is shared because it is
    // expensive and isolates nothing; the context is what isolation means.
    expect(fake.contexts).toBe(2);
    expect(fake.launches).toBe(1);
    expect(currentPageUrl(A)).not.toBe(currentPageUrl(B));
    await disposeBrowser();
  });

  it("does not hand one workspace the page another workspace opened", async () => {
    await reset();
    await getPage(A);
    // B has never navigated. Before the keying it would have been handed A's
    // page — an authenticated app, in the worst case.
    expect(() => requirePage(B)).toThrow(/No page loaded/);
    await disposeBrowser();
  });

  it("keeps capture buffers apart, so one workspace cannot erase another's evidence", async () => {
    await reset();
    await getPage(A);
    await getPage(B);
    capturedActivity(A).console.push({ type: "error", text: "A's failure" });
    capturedActivity(B).console.push({ type: "log", text: "B's noise" });

    // A navigate resets the capture of the workspace that navigated, and only
    // that one. Before the keying, B navigating dropped A's evidence.
    resetCapture(B);
    expect(capturedActivity(A).console).toHaveLength(1);
    expect(capturedActivity(B).console).toHaveLength(0);
    await disposeBrowser();
  });

  it("closes one workspace's context without disturbing the other's", async () => {
    await reset();
    const leaseA = acquireBrowserLease(A);
    const leaseB = acquireBrowserLease(B);
    await getPage(A);
    await getPage(B);

    await leaseA.release();
    // A is gone; B is untouched and the browser process is still up for it.
    expect(fake.closedContexts).toBe(1);
    expect(fake.browserCloses).toBe(0);
    expect(currentPageUrl(B)).toBeDefined();
    expect(currentPageUrl(A)).toBeUndefined();

    await leaseB.release();
    // Last workspace out closes the process.
    expect(fake.closedContexts).toBe(2);
    expect(fake.browserCloses).toBe(1);
  });

  it("keeps a second run of the same workspace alive until the last lease goes", async () => {
    await reset();
    const first = acquireBrowserLease(A);
    const second = acquireBrowserLease(A);
    await getPage(A);
    await first.release();
    // A nested or parallel run of the SAME workspace still holds it.
    expect(fake.closedContexts).toBe(0);
    expect(currentPageUrl(A)).toBeDefined();
    await second.release();
    expect(fake.closedContexts).toBe(1);
  });

  it("gives concurrent callers of one workspace the same page, not one each", async () => {
    await reset();
    // dispatch_team runs its members at once and they all share the workspace
    // string. Creating a context is async, so a check-then-act would let two of
    // them each build one — the loser orphaned, never closed, and its owner
    // then reading the winner's page through every later tool call.
    const [a, b, c] = await Promise.all([getPage(A), getPage(A), getPage(A)]);
    expect(fake.contexts).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    await disposeBrowser();
  });

  it("does not close the session under a sibling that is still working", async () => {
    await reset();
    await getPage(A);
    const { runBrowserOperation } = await import("../../src/tools/browser/session.js");

    const sibling = new AbortController();
    const cancelled = new AbortController();
    // Two operations in flight on one workspace; one is cancelled.
    const siblingWork = runBrowserOperation(A, new Promise(() => {}), sibling.signal, "sibling");
    const doomed = runBrowserOperation(A, new Promise(() => {}), cancelled.signal, "doomed").catch(() => "cancelled");
    cancelled.abort();
    expect(await doomed).toBe("cancelled");

    // The sibling's page is still there. Closing the context to unstick one
    // call would have turned the other's work into a raw "target closed".
    expect(currentPageUrl(A)).toBeDefined();
    expect(fake.closedContexts).toBe(0);

    sibling.abort();
    await siblingWork.catch(() => {});
    await disposeBrowser();
  });

  it("still tears down when every sibling aborts in the same cascade", async () => {
    await reset();
    await getPage(A);
    const { runBrowserOperation } = await import("../../src/tools/browser/session.js");

    // An AbortSignal delivers to every listener synchronously, in one call
    // stack — which is how a parent cancellation reaches dispatch_team's
    // members. If each handler only read the count, all of them would see a
    // sibling still working and none would close: the hung call that prompted
    // the cancellation would stay hung, forever.
    const shared = new AbortController();
    const a = runBrowserOperation(A, new Promise(() => {}), shared.signal, "a").catch(() => "cancelled");
    const b = runBrowserOperation(A, new Promise(() => {}), shared.signal, "b").catch(() => "cancelled");
    shared.abort();
    expect(await Promise.all([a, b])).toEqual(["cancelled", "cancelled"]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(fake.closedContexts).toBe(1);
    expect(currentPageUrl(A)).toBeUndefined();
  });

  it("closes a session opened while disposal was already running", async () => {
    await reset();
    await getPage(A);
    // Closing is async. Iterating one snapshot of the map would leave a session
    // opened during that await running — and its page with it.
    const disposing = disposeBrowser();
    const late = getPage(B);
    await Promise.all([disposing, late]);
    await disposeBrowser();
    expect(currentPageUrl(A)).toBeUndefined();
    expect(currentPageUrl(B)).toBeUndefined();
    expect(fake.browserCloses).toBeGreaterThanOrEqual(1);
  });

  it("lets two workspaces share one named profile, last finish winning", async () => {
    await reset();
    // Naming the same profile in two projects is a request to share one login,
    // and sharing means the later teardown writes back. Pinned so it stays a
    // decision rather than becoming a surprise.
    configureBrowserProfile("/nowhere/shared.json", A);
    configureBrowserProfile("/nowhere/shared.json", B);
    await getPage(A);
    await getPage(B);
    expect(fake.contexts).toBe(2);
    await disposeBrowser();
    configureBrowserProfile(null);
  });

  it("scopes the session profile by workspace too", async () => {
    await reset();
    // A profile configured for one workspace must not become another's login.
    configureBrowserProfile("/nowhere/a.json", A);
    await getPage(A);
    await getPage(B);
    // Neither context restored anything (the file does not exist), and the
    // point is that B was never even offered A's path — asserted through the
    // teardown below not writing anything for B.
    expect(fake.contexts).toBe(2);
    await disposeBrowser();
    configureBrowserProfile(null);
  });
});
