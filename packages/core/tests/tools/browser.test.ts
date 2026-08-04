import { afterEach, describe, expect, it } from "vitest";
import type { PermissionRequest } from "@seekforge/shared";
import { ToolError } from "../../src/tools/errors.js";
import {
  acquireBrowserLease,
  acquireLspServerLease,
  createDefaultDispatcher,
  disposeBrowser,
} from "../../src/tools/index.js";
import {
  assertBrowserUrlAllowed,
  browserTools,
  checkBrowserUrl,
  composeSelector,
  describeValue,
  interactionPermission,
  mapInteractionError,
} from "../../src/tools/browser/index.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

/**
 * These tests never launch a real browser (CI has none). They cover three things:
 *   1. the tools register with the expected schemas + permission levels,
 *   2. the pure decision logic of the interaction tools (selector composition,
 *      permission level, Playwright error translation), and
 *   3. graceful degradation — with playwright-core absent, every tool returns a
 *      clear, actionable "browser_unavailable" error instead of crashing.
 * The optional dep is not installed in this workspace, so the dynamic import in
 * playwright.ts fails and exercises the degradation path for free.
 *
 * A real Chromium drives the same tools end to end in scripts/browser-tools-smoke.mjs.
 */

const INSPECT_NAMES = [
  "browser_navigate",
  "browser_screenshot",
  "browser_snapshot",
  "browser_console",
  "browser_network",
];
const INTERACT_NAMES = [
  "browser_click",
  "browser_fill",
  "browser_select",
  "browser_press",
  "browser_wait_for",
  "browser_upload",
];
const NAMES = [...INSPECT_NAMES, ...INTERACT_NAMES];

describe("browser tools registration", () => {
  afterEach(async () => {
    await disposeBrowser();
  });

  it("exposes exactly the navigate, inspect and interaction tools", () => {
    expect(browserTools.map((t) => t.name).sort()).toEqual([...NAMES].sort());
  });

  it("exports idempotent per-run browser and workspace LSP leases", async () => {
    const firstBrowserRun = acquireBrowserLease();
    const secondBrowserRun = acquireBrowserLease();
    const lspRun = acquireLspServerLease(makeWorkspace());

    await firstBrowserRun.release();
    await firstBrowserRun.release();
    await secondBrowserRun.release();
    await lspRun.release();
    await lspRun.release();
  });

  it("advertises all of them through the default dispatcher", () => {
    const defs = createDefaultDispatcher().list();
    for (const name of NAMES) {
      expect(defs.find((d) => d.name === name)).toBeDefined();
    }
  });

  it("classifies browser_navigate as env, showing the raw url", () => {
    const nav = browserTools.find((t) => t.name === "browser_navigate")!;
    const cls = nav.classify({ url: "http://localhost:5173/" } as never, makeCtx(makeWorkspace()));
    expect(cls.permission).toBe("env");
    expect(cls.command).toBe("GET http://localhost:5173/");
  });

  it("classifies the inspect tools at read-only / execute (no new outward action)", () => {
    const level = (name: string) =>
      browserTools.find((t) => t.name === name)!.classify({} as never, makeCtx(makeWorkspace())).permission;
    expect(level("browser_snapshot")).toBe("readonly");
    expect(level("browser_console")).toBe("readonly");
    expect(level("browser_network")).toBe("readonly");
    expect(level("browser_screenshot")).toBe("execute");
    // Waiting only observes, so it stays read-only whatever the page is.
    expect(level("browser_wait_for")).toBe("readonly");
  });
});

describe("browser URL policy", () => {
  it.each(["http://localhost:5173/", "http://127.0.0.1:3000/", "http://[::1]:8080/"])(
    "allows an explicitly confirmed loopback dev server: %s",
    (url) => expect(checkBrowserUrl(url).href).toBe(url),
  );

  it.each(["http://10.0.0.1/", "http://192.168.1.2/", "http://169.254.169.254/"])(
    "still blocks non-loopback private targets: %s",
    (url) => expect(() => checkBrowserUrl(url)).toThrowError(/private|loopback/i),
  );

  it("blocks a public-looking host whose DNS answer is private", async () => {
    await expect(
      assertBrowserUrlAllowed("https://public.example/", async () => [{ address: "10.0.0.5", family: 4 }]),
    ).rejects.toThrow(/resolves to a private/i);
  });

  it("stops waiting for DNS when browser navigation is cancelled", async () => {
    const controller = new AbortController();
    const resolver = async (): Promise<never> => await new Promise<never>(() => {});
    const pending = assertBrowserUrlAllowed("https://public.example/", resolver, controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "fetch_failed" });
  });

  it("does not DNS-resolve explicitly allowed loopback development URLs", async () => {
    let called = false;
    await expect(
      assertBrowserUrlAllowed("http://localhost:5173/", async () => {
        called = true;
        return [];
      }),
    ).resolves.toBeInstanceOf(URL);
    expect(called).toBe(false);
  });
});

describe("interaction targeting and failure translation", () => {
  it("leaves an unambiguous selector alone and narrows an indexed one", () => {
    expect(composeSelector("#save")).toBe("#save");
    expect(composeSelector("button.row", 2)).toBe("button.row >> nth=2");
    // Index 0 is a real choice ("the first of several"), not an absent one.
    expect(composeSelector("button.row", 0)).toBe("button.row >> nth=0");
  });

  it("collapses and caps values shown in a confirmation prompt", () => {
    expect(describeValue("  sign\n  in  ")).toBe("sign in");
    const long = describeValue("x".repeat(500));
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(121);
  });

  it("turns a strict-mode violation into an actionable ambiguity error", () => {
    const err = mapInteractionError(
      new Error('locator.click: Error: strict mode violation: "button" resolved to 3 elements'),
      "Click",
      "button",
    );
    expect(err.code).toBe("ambiguous_selector");
    expect(err.message).toContain("3 elements");
    expect(err.message).toContain("index");
  });

  it("turns a Playwright timeout into element_not_found with the next step", () => {
    const timeout = Object.assign(new Error("Timeout 15000ms exceeded."), { name: "TimeoutError" });
    const err = mapInteractionError(timeout, "Click", "#missing");
    expect(err.code).toBe("element_not_found");
    expect(err.message).toContain("browser_snapshot");
  });

  it("passes a cancellation through untouched instead of relabelling it", () => {
    const cancelled = new ToolError("cancelled", "Click cancelled");
    expect(mapInteractionError(cancelled, "Click", "#save")).toBe(cancelled);
  });

  it("keeps interactions at execute while no page is loaded", () => {
    // Nothing to act on yet: run() fails with no_page, so prompting would be
    // asking the user to approve an action with no possible effect.
    expect(interactionPermission()).toBe("execute");
  });
});

describe("browser tools graceful degradation (Playwright absent)", () => {
  afterEach(async () => {
    await disposeBrowser();
  });

  it("browser_navigate reports an actionable install hint", async () => {
    const dispatcher = createDefaultDispatcher();
    const res = await dispatcher.execute(
      call("browser_navigate", { url: "http://example.com/" }),
      makeCtx(makeWorkspace()),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("browser_unavailable");
    expect(res.error?.message).toContain("playwright-core");
    expect(res.error?.message).toContain("playwright install chromium");
  });

  const ARGS: Record<string, Record<string, unknown>> = {
    browser_upload: { selector: "#file", path: "a.txt" },
    browser_screenshot: { path: "shot.png" },
    browser_click: { selector: "#save" },
    browser_fill: { selector: "#name", text: "hello" },
    browser_select: { selector: "#country", value: "NL" },
    browser_press: { key: "Enter" },
    browser_wait_for: { selector: "#done" },
  };

  it.each(["browser_screenshot", "browser_snapshot", "browser_console", ...INTERACT_NAMES])(
    "%s reports browser_unavailable when Playwright is missing",
    async (name) => {
      const dispatcher = createDefaultDispatcher();
      const res = await dispatcher.execute(call(name, ARGS[name] ?? {}), makeCtx(makeWorkspace()));
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("browser_unavailable");
    },
  );

  it.each([
    ["browser_select", { selector: "#c", value: "a", label: "A" }],
    ["browser_select", { selector: "#c" }],
    ["browser_wait_for", { selector: "#a", text: "a" }],
    ["browser_wait_for", {}],
  ] as const)("%s rejects an ambiguous target instead of guessing", async (name, args) => {
    const dispatcher = createDefaultDispatcher();
    const res = await dispatcher.execute(call(name, args), makeCtx(makeWorkspace()));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalid_args");
  });

  it("browser_navigate refuses private/loopback urls before touching Playwright", async () => {
    const dispatcher = createDefaultDispatcher();
    // env-level tool prompts; approve so we reach the SSRF guard in run().
    const requests: PermissionRequest[] = [];
    const ctx = makeCtx(makeWorkspace(), {
      policy: { approvalMode: "auto" },
      confirm: async (req) => {
        requests.push(req);
        return true;
      },
    });
    const res = await dispatcher.execute(call("browser_navigate", { url: "http://169.254.169.254/" }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("private_address");
    // The env-level tool prompted even in auto mode, surfacing the raw url.
    expect(requests[0]?.command).toBe("GET http://169.254.169.254/");
  });

  it("browser_navigate rejects a non-http(s) scheme", async () => {
    const dispatcher = createDefaultDispatcher();
    const res = await dispatcher.execute(
      call("browser_navigate", { url: "file:///etc/passwd" }),
      makeCtx(makeWorkspace()),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalid_url");
  });

  it("rejects invalid arguments before running", async () => {
    const dispatcher = createDefaultDispatcher();
    const res = await dispatcher.execute(call("browser_navigate", {}), makeCtx(makeWorkspace()));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalid_args");
  });
});

describe("browser_upload", () => {
  it("shows the raw path it is about to hand to the page", () => {
    // Uploading is the one interaction that takes something OUT of the
    // workspace, so which file it is has to be visible before it is approved.
    const upload = browserTools.find((t) => t.name === "browser_upload")!;
    const cls = upload.classify({ selector: "#file", path: "fixtures/a.png" } as never, makeCtx(makeWorkspace()));
    expect(cls.description).toContain("fixtures/a.png");
    expect(cls.path).toBe("fixtures/a.png");
  });

  it("refuses a path that escapes the workspace before touching the page", async () => {
    const ws = makeWorkspace();
    const res = await createDefaultDispatcher().execute(
      call("browser_upload", { selector: "#file", path: "../../etc/passwd" }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(false);
    // The sandbox rejects it; the browser is never even asked.
    expect(res.error?.code).not.toBe("browser_unavailable");
  });
});
