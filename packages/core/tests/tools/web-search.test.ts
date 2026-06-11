import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionRequest } from "@seekforge/shared";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { decodeDdgUrl, parseDdgResults } from "../../src/tools/builtins/web.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

/**
 * A captured-shape DuckDuckGo HTML result page (trimmed). The real endpoint
 * wraps each result URL as /l/?uddg=<percent-encoded target> and exposes the
 * title in an <a class="result__a"> and the description in a
 * <a class="result__snippet">.
 */
const DDG_FIXTURE = `
<!DOCTYPE html><html><body>
<div class="result results_links results_links_deep web-result">
  <div class="result__body links_main links_deep">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a"
         href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fdocs&amp;rut=abc">
        Node.js &amp; Docs
      </a>
    </h2>
    <a class="result__snippet"
       href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fdocs">
       The official <b>Node.js</b> documentation &amp; API reference.
    </a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="result__body links_main links_deep">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a"
         href="/l/?uddg=https%3A%2F%2Fexample.com%2Fguide%3Fa%3D1%26b%3D2">
        Example Guide
      </a>
    </h2>
    <a class="result__snippet" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fguide">
       A practical guide with examples.
    </a>
  </div>
</div>
</body></html>`;

describe("decodeDdgUrl", () => {
  it("decodes the uddg redirect target", () => {
    expect(decodeDdgUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fdocs")).toBe(
      "https://nodejs.org/docs",
    );
    expect(
      decodeDdgUrl("/l/?uddg=https%3A%2F%2Fexample.com%2Fguide%3Fa%3D1%26b%3D2"),
    ).toBe("https://example.com/guide?a=1&b=2");
  });

  it("rejects non-http(s) and unparseable hrefs", () => {
    expect(decodeDdgUrl("/l/?uddg=javascript%3Aalert(1)")).toBeUndefined();
    expect(decodeDdgUrl("")).toBeUndefined();
  });
});

describe("parseDdgResults", () => {
  it("parses titles, decoded urls, and snippets", () => {
    const results = parseDdgResults(DDG_FIXTURE, 5);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "Node.js & Docs",
      url: "https://nodejs.org/docs",
      snippet: "The official Node.js documentation & API reference.",
    });
    expect(results[1]?.url).toBe("https://example.com/guide?a=1&b=2");
    expect(results[1]?.title).toBe("Example Guide");
  });

  it("honors the limit", () => {
    expect(parseDdgResults(DDG_FIXTURE, 1)).toHaveLength(1);
  });

  it("returns [] for empty or garbled markup", () => {
    expect(parseDdgResults("", 5)).toEqual([]);
    expect(parseDdgResults("<html><body>no results here</body></html>", 5)).toEqual([]);
    expect(parseDdgResults("<a class='result__a'>broken", 5)).toEqual([]);
  });
});

describe("web_search tool (through dispatcher)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fetchReturning(body: string, ok = true, status = 200): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok,
        status,
        headers: new Headers({ "content-type": "text/html" }),
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      })) as unknown as typeof fetch,
    );
  }

  function scriptedConfirm(answer: boolean): {
    confirm: (req: PermissionRequest) => Promise<boolean>;
    requests: PermissionRequest[];
  } {
    const requests: PermissionRequest[] = [];
    return {
      requests,
      confirm: async (req) => {
        requests.push(req);
        return answer;
      },
    };
  }

  it("is env-permission: prompts even in auto mode and runs when confirmed", async () => {
    fetchReturning(DDG_FIXTURE);
    const dispatcher = createDefaultDispatcher();
    const { confirm, requests } = scriptedConfirm(true);
    // approvalMode "auto" would auto-allow writes, but env always prompts.
    const ctx = makeCtx(makeWorkspace(), { policy: { approvalMode: "auto" }, confirm });

    const res = await dispatcher.execute(call("web_search", { query: "node docs" }), ctx);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.permission).toBe("env");
    expect(requests[0]?.command).toBe("SEARCH node docs");
    expect(res.ok).toBe(true);
    const data = res.data as { results: { title: string; url: string }[]; note: string };
    expect(data.results).toHaveLength(2);
    expect(data.results[0]?.url).toBe("https://nodejs.org/docs");
    expect(data.note).toMatch(/verify/i);
  });

  it("denies when the user declines the env prompt — no fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
    const dispatcher = createDefaultDispatcher();
    const { confirm } = scriptedConfirm(false);
    const ctx = makeCtx(makeWorkspace(), { policy: { approvalMode: "auto" }, confirm });

    const res = await dispatcher.execute(call("web_search", { query: "x" }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_by_user");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns {results: []} with a note on garbled markup instead of throwing", async () => {
    fetchReturning("<html>totally different layout</html>");
    const dispatcher = createDefaultDispatcher();
    const ctx = makeCtx(makeWorkspace(), { confirm: async () => true });

    const res = await dispatcher.execute(call("web_search", { query: "x" }), ctx);
    expect(res.ok).toBe(true);
    const data = res.data as { results: unknown[]; note: string };
    expect(data.results).toEqual([]);
    expect(data.note).toMatch(/no results/i);
  });

  it("maps HTTP errors to a search_failed ToolError", async () => {
    fetchReturning("", false, 503);
    const dispatcher = createDefaultDispatcher();
    const ctx = makeCtx(makeWorkspace(), { confirm: async () => true });
    const res = await dispatcher.execute(call("web_search", { query: "x" }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("search_failed");
  });

  it("caps count at 10", async () => {
    const res = await createDefaultDispatcher().execute(
      call("web_search", { query: "x", count: 99 }),
      makeCtx(makeWorkspace(), { confirm: async () => false }),
    );
    // schema rejects > 10 before any fetch.
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalid_args");
  });
});
