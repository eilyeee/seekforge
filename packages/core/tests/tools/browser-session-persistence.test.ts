import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The lifecycle half of browser-session persistence: WHEN the login is written,
 * and whether a run that says it has finished releasing the browser has
 * actually finished writing it.
 *
 * Playwright is not installed here (and CI has no Chromium), so the module's
 * dynamic import is replaced with a fake browser that records what it was asked
 * for. That is enough: everything under test is this module's own sequencing.
 */

const fake = vi.hoisted(() => ({
  /** Options newContext() was called with — how a restore is observed. */
  contextOptions: [] as unknown[],
  /** Resolves the pending storageState() call, to hold teardown open. */
  releaseState: undefined as (() => void) | undefined,
  stateCalls: 0,
  closed: 0,
}));

vi.mock("../../src/tools/browser/playwright.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/tools/browser/playwright.js")>();
  const page = {
    on: () => {},
    url: () => "https://example.test/",
  };
  const context = {
    newPage: async () => page,
    route: async () => {},
    storageState: async () => {
      fake.stateCalls += 1;
      if (fake.releaseState) {
        await new Promise<void>((resolve) => {
          fake.releaseState = resolve;
        });
      }
      return { cookies: [{ name: "session", value: "live" }] };
    },
  };
  return {
    ...actual,
    loadPlaywright: async () => ({
      chromium: {
        launch: async () => ({
          newContext: async (opts?: unknown) => {
            fake.contextOptions.push(opts);
            return context;
          },
          close: async () => {
            fake.closed += 1;
          },
          process: () => null,
        }),
      },
    }),
  };
});

const { acquireBrowserLease, configureBrowserProfile, disposeBrowser, resolveBrowserProfilePath } = await import(
  "../../src/tools/browser/index.js"
);
// getPage/runBrowserOperation are session-internal (the tools use them, not apps).
const { getPage, runBrowserOperation } = await import("../../src/tools/browser/session.js");

function fakeHome(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-home-")));
}

afterEach(async () => {
  fake.contextOptions = [];
  fake.releaseState = undefined;
  fake.stateCalls = 0;
  fake.closed = 0;
  await disposeBrowser();
  configureBrowserProfile(null);
});

describe("browser session persistence", () => {
  it("writes the session when a run finishes, and restores it on the next one", async () => {
    const home = fakeHome();
    const profile = resolveBrowserProfilePath(home, "work");
    configureBrowserProfile(profile);

    const lease = acquireBrowserLease();
    await getPage();
    // A first run has nothing to restore from — the context starts logged out.
    expect(fake.contextOptions[0]).toBeUndefined();
    await lease.release();

    expect(JSON.parse(fs.readFileSync(profile, "utf8")).cookies).toHaveLength(1);

    const second = acquireBrowserLease();
    await getPage();
    expect(fake.contextOptions[1]).toEqual({ storageState: profile });
    await second.release();
  });

  it("keeps every run ephemeral when no profile is configured", async () => {
    configureBrowserProfile(null);
    const lease = acquireBrowserLease();
    await getPage();
    await lease.release();
    // Not merely "wrote nowhere" — it never asked the context for its cookies.
    expect(fake.stateCalls).toBe(0);
  });

  it("does not overwrite a saved login when the run is cancelled", async () => {
    const home = fakeHome();
    const profile = resolveBrowserProfilePath(home, "work");
    configureBrowserProfile(profile);
    fs.mkdirSync(path.dirname(profile), { recursive: true });
    fs.writeFileSync(profile, JSON.stringify({ cookies: [{ name: "session", value: "the good one" }] }));

    const controller = new AbortController();
    const lease = acquireBrowserLease();
    await getPage();
    const pending = runBrowserOperation(new Promise(() => {}), controller.signal, "navigate").catch(() => {});
    controller.abort();
    await pending;
    await lease.release();

    // Cancelling halfway through a login redirect must not replace a working
    // session with the half-finished one.
    expect(JSON.parse(fs.readFileSync(profile, "utf8")).cookies[0].value).toBe("the good one");
  });

  it("a second teardown waits for the write already in flight", async () => {
    const home = fakeHome();
    const profile = resolveBrowserProfilePath(home, "work");
    configureBrowserProfile(profile);
    // Hold storageState() open so the first teardown is provably mid-write.
    fake.releaseState = () => {};

    const lease = acquireBrowserLease();
    await getPage();
    const first = lease.release();
    await new Promise((resolve) => setImmediate(resolve));

    // The run's cleanup arrives while the write is still happening. If it
    // returned here, "browser released" would be a lie and a process exiting
    // now would lose the login.
    let disposed = false;
    const second = disposeBrowser().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(disposed).toBe(false);

    fake.releaseState?.();
    await Promise.all([first, second]);
    expect(disposed).toBe(true);
    expect(fs.existsSync(profile)).toBe(true);
  });
});
