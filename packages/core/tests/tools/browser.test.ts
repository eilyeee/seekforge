import { afterEach, describe, expect, it } from "vitest";
import type { PermissionRequest } from "@seekforge/shared";
import { createDefaultDispatcher, disposeBrowser } from "../../src/tools/index.js";
import { browserTools, checkBrowserUrl } from "../../src/tools/builtins/browser.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

/**
 * These tests never launch a real browser (CI has none). They cover two things:
 *   1. the four tools register with the expected schemas + permission levels, and
 *   2. graceful degradation — with playwright-core absent, every tool returns a
 *      clear, actionable "browser_unavailable" error instead of crashing.
 * The optional dep is not installed in this workspace, so the dynamic import in
 * browser.ts fails and exercises the degradation path for free.
 */

const NAMES = ["browser_navigate", "browser_screenshot", "browser_snapshot", "browser_console"];

describe("browser tools registration", () => {
  afterEach(async () => {
    await disposeBrowser();
  });

  it("exposes exactly the four browser tools", () => {
    expect(browserTools.map((t) => t.name).sort()).toEqual([...NAMES].sort());
  });

  it("advertises all four through the default dispatcher", () => {
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
    expect(level("browser_screenshot")).toBe("execute");
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

  it.each(["browser_screenshot", "browser_snapshot", "browser_console"])(
    "%s reports browser_unavailable when Playwright is missing",
    async (name) => {
      const dispatcher = createDefaultDispatcher();
      const args = name === "browser_screenshot" ? { path: "shot.png" } : {};
      const res = await dispatcher.execute(call(name, args), makeCtx(makeWorkspace()));
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("browser_unavailable");
    },
  );

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
