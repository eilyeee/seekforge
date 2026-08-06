import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PermissionRequest } from "@seekforge/shared";
import { createDefaultDispatcher, type ToolContext } from "../../src/tools/index.js";
import { browserTools, disposeBrowser, interactionPermission } from "../../src/tools/browser/index.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

/**
 * The browser tools driven end to end against a scriptable fake Playwright
 * (tests/tools/fixtures/fake-playwright.mjs), reached through the same
 * SEEKFORGE_PLAYWRIGHT override a user would point at their own installation.
 *
 * These cover what a missing-dependency test cannot: the capture reset on
 * navigation, the permission level derived from the loaded page's own URL, the
 * per-request SSRF re-check the context installs, and what each interaction
 * reports back about the page it just changed.
 */

const FIXTURE = pathToFileURL(path.join(import.meta.dirname, "fixtures", "fake-playwright.mjs")).href;

type FakeState = {
  url: string;
  actions: Array<Record<string, unknown>>;
  failures: Record<string, { message: string; name?: string }>;
  navigateTo: Record<string, string>;
  emitErrorOn: Record<string, string>;
  selectResult: string[];
  snapshot: Record<string, unknown>;
  handlers: Record<string, Array<(arg: never) => void>>;
  routeHandler?: (route: unknown) => Promise<void>;
  closed?: number;
  launched?: number;
};

/** The fake's shared state, created on demand so a test can script it before the first call. */
function fake(): FakeState {
  const g = globalThis as unknown as { __fakePlaywright?: FakeState };
  g.__fakePlaywright ??= {} as FakeState;
  const s = g.__fakePlaywright;
  s.failures ??= {};
  s.navigateTo ??= {};
  s.emitErrorOn ??= {};
  return s;
}

let previousOverride: string | undefined;
let workspace: string;
let dispatcher: ReturnType<typeof createDefaultDispatcher>;

beforeAll(() => {
  previousOverride = process.env.SEEKFORGE_PLAYWRIGHT;
  process.env.SEEKFORGE_PLAYWRIGHT = FIXTURE;
});

afterAll(() => {
  if (previousOverride === undefined) delete process.env.SEEKFORGE_PLAYWRIGHT;
  else process.env.SEEKFORGE_PLAYWRIGHT = previousOverride;
});

beforeEach(() => {
  (globalThis as unknown as { __fakePlaywright?: FakeState }).__fakePlaywright = undefined;
  workspace = makeWorkspace();
  dispatcher = createDefaultDispatcher();
});

afterEach(async () => {
  await disposeBrowser();
  fs.rmSync(workspace, { recursive: true, force: true });
});

const ctx = (overrides: Parameters<typeof makeCtx>[1] = {}): ToolContext => makeCtx(workspace, overrides);

async function navigate(url = "http://127.0.0.1:5173/"): Promise<void> {
  const res = await dispatcher.execute(call("browser_navigate", { url }), ctx());
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
}

describe("navigation and page inspection", () => {
  it("reports the landed url, status and title, and launches one browser", async () => {
    const res = await dispatcher.execute(call("browser_navigate", { url: "http://localhost:3000/app" }), ctx());
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ url: "http://localhost:3000/app", status: 200, title: "Fake" });
    expect(fake().launched).toBe(1);
  });

  it("reuses the one browser across calls and closes it exactly once on dispose", async () => {
    await navigate();
    await navigate("http://127.0.0.1:5173/second");
    expect(fake().launched).toBe(1);

    await disposeBrowser();
    expect(fake().closed).toBe(1);
  });

  it("clears captured console output when a new page loads", async () => {
    await navigate();
    const first = await dispatcher.execute(call("browser_console", {}), ctx());
    expect((first.data as { console: unknown[] }).console).toHaveLength(1);

    await navigate("http://127.0.0.1:5173/second");
    const second = await dispatcher.execute(call("browser_console", {}), ctx());
    // One entry: the second navigation's own message, not the first page's.
    expect((second.data as { console: { text: string }[] }).console).toEqual([
      { type: "log", text: "navigated to http://127.0.0.1:5173/second" },
    ]);
  });

  it("writes a screenshot inside the workspace and returns its relative path", async () => {
    await navigate();
    const res = await dispatcher.execute(call("browser_screenshot", { path: "shots/home.png" }), ctx());
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ path: "shots/home.png" });
    expect(fs.readFileSync(path.join(workspace, "shots/home.png"), "utf8")).toBe("fake-png");
  });

  it("summarizes the page the extraction actually saw", async () => {
    const el = (tag: string, text: string, attrs: Record<string, string> = {}): unknown => ({
      tagName: tag.toUpperCase(),
      textContent: text,
      getAttribute: (name: string) => attrs[name] ?? null,
      value: attrs.value,
    });
    await navigate();
    Object.assign(fake(), {
      bodyText: "Dashboard\n\n\n\nWelcome back",
      dom: {
        "h1,h2,h3": [el("h1", "  Dashboard  "), el("h2", "hi"), el("h3", "")],
        "a[href]": [el("a", "Settings"), el("a", "")],
        "button, [role=button], input[type=submit], input[type=button]": [
          el("button", "Save"),
          el("input", "", { value: "Submit" }),
        ],
        "input, textarea, select": [el("input", "", { name: "email", type: "email", placeholder: "you@example.com" })],
      },
    });

    const res = await dispatcher.execute(call("browser_snapshot", {}), ctx());
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({
      // Whitespace collapsed; the empty h3 renders as "h3: " and is dropped.
      headings: ["h1: Dashboard", "h2: hi"],
      // The empty link is dropped; the submit input falls back to its value.
      links: ["Settings"],
      buttons: ["Save", "Submit"],
      inputs: ["email email you@example.com"],
      // Runs of blank lines are collapsed.
      text: "Dashboard\n\nWelcome back",
    });
  });

  it("reports a failed navigation instead of pretending the page loaded", async () => {
    fake().failures["http://127.0.0.1:5173/"] = { message: "net::ERR_CONNECTION_REFUSED" };
    const res = await dispatcher.execute(call("browser_navigate", { url: "http://127.0.0.1:5173/" }), ctx());
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("navigation_failed");
    expect(res.error?.message).toContain("ERR_CONNECTION_REFUSED");
  });

  it("still reports the landed url when only the title read fails", async () => {
    const res = await dispatcher.execute(
      call("browser_navigate", { url: "http://127.0.0.1:5173/" }),
      ctx({ signal: undefined }),
    );
    expect(res.ok).toBe(true);
    fake().failures["title"] = { message: "detached" };
    const second = await dispatcher.execute(call("browser_navigate", { url: "http://127.0.0.1:5173/x" }), ctx());
    expect(second.ok).toBe(true);
    expect(second.data).toMatchObject({ url: "http://127.0.0.1:5173/x", title: "" });
  });

  it("reports a screenshot failure rather than a path that was never written", async () => {
    await navigate();
    fake().failures["screenshot"] = { message: "target closed" };
    const res = await dispatcher.execute(call("browser_screenshot", {}), ctx());
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("screenshot_failed");
  });

  it("refuses a screenshot path that escapes the workspace", async () => {
    await navigate();
    const res = await dispatcher.execute(call("browser_screenshot", { path: "../escape.png" }), ctx());
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("outside_workspace");
  });

  it("requires a navigation before the inspect and interaction tools", async () => {
    for (const [name, args] of [
      ["browser_snapshot", {}],
      ["browser_console", {}],
      ["browser_click", { selector: "#a" }],
      ["browser_wait_for", { selector: "#a" }],
    ] as const) {
      const res = await dispatcher.execute(call(name, args), ctx());
      expect(res.ok, name).toBe(false);
      expect(res.error?.code, name).toBe("no_page");
    }
  });
});

describe("the per-request guard installed on the browser context", () => {
  it("lets a loopback request through and aborts a private-network one", async () => {
    await navigate();
    const handler = fake().routeHandler!;
    const attempt = async (url: string): Promise<string> => {
      let outcome = "none";
      await handler({
        request: () => ({ url: () => url }),
        continue: async () => {
          outcome = "continued";
        },
        abort: async (code?: string) => {
          outcome = `aborted:${code}`;
        },
      });
      return outcome;
    };

    expect(await attempt("http://127.0.0.1:5173/api/items")).toBe("continued");
    // A redirect into the LAN or the cloud metadata endpoint is blocked even
    // though the navigation the user approved was loopback.
    expect(await attempt("http://169.254.169.254/latest/meta-data/")).toBe("aborted:blockedbyclient");
    expect(await attempt("http://192.168.0.10/admin")).toBe("aborted:blockedbyclient");
  });
});

describe("permission level follows the loaded page", () => {
  const permissionOf = (name: string, args: Record<string, unknown>): string =>
    browserTools.find((t) => t.name === name)!.classify(args as never, ctx()).permission;

  it("treats acting on a loopback dev server as ordinary work", async () => {
    await navigate("http://localhost:5173/");
    expect(interactionPermission(workspace)).toBe("execute");
    expect(permissionOf("browser_click", { selector: "#save" })).toBe("execute");
    expect(permissionOf("browser_fill", { selector: "#name", text: "x" })).toBe("execute");
  });

  it("always confirms acting on a page that is not the developer's own machine", async () => {
    await navigate("https://example.com/checkout");
    expect(interactionPermission(workspace)).toBe("env");
    expect(permissionOf("browser_click", { selector: "#buy" })).toBe("env");
    expect(permissionOf("browser_press", { key: "Enter" })).toBe("env");
    // Waiting changes nothing, so it stays read-only wherever the page is.
    expect(permissionOf("browser_wait_for", { selector: "#done" })).toBe("readonly");
  });

  it("prompts for a public-page click even in auto mode, naming the page", async () => {
    await navigate("https://example.com/checkout");
    const requests: PermissionRequest[] = [];
    const res = await dispatcher.execute(
      call("browser_click", { selector: "#buy" }),
      ctx({
        policy: { approvalMode: "auto" },
        confirm: async (req) => {
          requests.push(req);
          return true;
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.description).toBe("Click #buy on https://example.com/checkout");
  });

  it("does not prompt for the same click on a loopback page in auto mode", async () => {
    await navigate("http://127.0.0.1:5173/");
    let prompted = 0;
    const res = await dispatcher.execute(
      call("browser_click", { selector: "#buy" }),
      ctx({
        policy: { approvalMode: "auto" },
        confirm: async () => {
          prompted++;
          return true;
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(prompted).toBe(0);
  });
});

describe("what an interaction reports back", () => {
  it("reports a click that navigated, and the errors it raised", async () => {
    await navigate();
    fake().navigateTo["#go"] = "http://127.0.0.1:5173/done";
    fake().emitErrorOn["#go"] = "boom";

    const res = await dispatcher.execute(call("browser_click", { selector: "#go" }), ctx());
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({
      selector: "#go",
      url: "http://127.0.0.1:5173/done",
      navigated: true,
      errorsDuring: ["boom"],
    });
  });

  it("reports a click that changed nothing as not navigated", async () => {
    await navigate();
    const res = await dispatcher.execute(call("browser_click", { selector: "#noop" }), ctx());
    expect(res.data).toMatchObject({ navigated: false, errorsDuring: [] });
  });

  it("narrows an ambiguous selector with index before touching the page", async () => {
    await navigate();
    await dispatcher.execute(call("browser_click", { selector: "button.row", index: 2 }), ctx());
    expect(fake().actions.at(-1)).toMatchObject({ type: "click", selector: "button.row >> nth=2" });
  });

  it("fills a field without echoing what it typed", async () => {
    await navigate();
    const res = await dispatcher.execute(
      call("browser_fill", { selector: "#password", text: "hunter2-secret" }),
      ctx(),
    );
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ selector: "#password", filled: 14, submitted: false });
    expect(JSON.stringify(res.data)).not.toContain("hunter2");
    expect(fake().actions.at(-1)).toMatchObject({ type: "fill", value: "hunter2-secret" });
  });

  it("presses Enter after filling when asked to submit, and keeps both steps' errors", async () => {
    await navigate();
    fake().emitErrorOn["#q"] = "validation failed";
    const res = await dispatcher.execute(
      call("browser_fill", { selector: "#q", text: "seekforge", submit: true }),
      ctx(),
    );
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ submitted: true });
    // The fill raised it, the submit did not: both are reported.
    expect((res.data as { errorsDuring: string[] }).errorsDuring).toEqual(["validation failed"]);
    expect(fake().actions.at(-1)).toMatchObject({ type: "press", selector: "#q", key: "Enter" });
  });

  it("selects by label and reports the option that was chosen", async () => {
    await navigate();
    fake().selectResult = ["nl"];
    const res = await dispatcher.execute(call("browser_select", { selector: "#country", label: "Netherlands" }), ctx());
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ selected: ["nl"] });
    expect(fake().actions.at(-1)).toMatchObject({ values: { label: "Netherlands" } });
  });

  it("fails with option_not_found when nothing matched, instead of reporting success", async () => {
    await navigate();
    fake().selectResult = [];
    const res = await dispatcher.execute(call("browser_select", { selector: "#country", value: "zz" }), ctx());
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("option_not_found");
    expect(res.error?.message).toContain("browser_snapshot");
  });

  it("sends a key to the focused element when no selector is given", async () => {
    await navigate();
    const res = await dispatcher.execute(call("browser_press", { key: "Escape" }), ctx());
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ key: "Escape" });
    expect(fake().actions.at(-1)).toEqual({ type: "keyboardPress", key: "Escape" });
  });

  it("waits for text through the same selector slot", async () => {
    await navigate();
    const res = await dispatcher.execute(call("browser_wait_for", { text: "Saved", state: "visible" }), ctx());
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ selector: "text=Saved", state: "visible" });
    expect(fake().actions.at(-1)).toMatchObject({ selector: "text=Saved", opts: { state: "visible" } });
  });

  it("translates a Playwright timeout into element_not_found", async () => {
    await navigate();
    fake().failures["#missing"] = { message: "Timeout 15000ms exceeded.", name: "TimeoutError" };
    const res = await dispatcher.execute(call("browser_click", { selector: "#missing" }), ctx());
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("element_not_found");
  });

  it("translates a strict-mode violation into ambiguous_selector", async () => {
    await navigate();
    fake().failures["button"] = { message: 'strict mode violation: "button" resolved to 4 elements' };
    const res = await dispatcher.execute(call("browser_click", { selector: "button" }), ctx());
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("ambiguous_selector");
    expect(res.error?.message).toContain("4 elements");
  });
});

describe("the page an action was approved against", () => {
  it("refuses to act after the page moved between the approval and the action", async () => {
    await navigate("http://127.0.0.1:5173/");
    const res = await dispatcher.execute(
      call("browser_click", { selector: "#buy" }),
      ctx({
        policy: { approvalMode: "confirm" },
        // Something else — a parallel subagent, a slow redirect — moves the
        // shared page while the prompt is on screen.
        confirm: async () => {
          fake().url = "https://example.com/checkout";
          return true;
        },
      }),
    );

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("page_changed");
    // Nothing was clicked on the page the user never saw.
    expect(fake().actions.some((a) => a.type === "click")).toBe(false);
  });

  it("allows a fill that navigates to still submit", async () => {
    await navigate();
    fake().navigateTo["#q"] = "http://127.0.0.1:5173/results";
    const res = await dispatcher.execute(
      call("browser_fill", { selector: "#q", text: "seekforge", submit: true }),
      ctx(),
    );
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(fake().actions.at(-1)).toMatchObject({ type: "press", key: "Enter" });
  });
});

describe("cancellation", () => {
  it("tears the browser down when the run is aborted mid-action", async () => {
    await navigate();
    const controller = new AbortController();
    controller.abort();

    const res = await dispatcher.execute(
      call("browser_click", { selector: "#save" }),
      ctx({ signal: controller.signal }),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("cancelled");
  });
});
