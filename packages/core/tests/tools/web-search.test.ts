import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionRequest } from "@seekforge/shared";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { configureWebSearch, decodeDdgUrl, parseDdgResults } from "../../src/tools/builtins/web.js";
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
    expect(decodeDdgUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fdocs")).toBe("https://nodejs.org/docs");
    expect(decodeDdgUrl("/l/?uddg=https%3A%2F%2Fexample.com%2Fguide%3Fa%3D1%26b%3D2")).toBe(
      "https://example.com/guide?a=1&b=2",
    );
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

  function fetchReturning(body: string, status = 200): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            status,
            headers: { "content-type": "text/html" },
          }),
      ) as unknown as typeof fetch,
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

  it("returns {results: []} on garbled markup, and says the search did not run", async () => {
    fetchReturning("<html>totally different layout</html>");
    const dispatcher = createDefaultDispatcher();
    const ctx = makeCtx(makeWorkspace(), { confirm: async () => true });

    const res = await dispatcher.execute(call("web_search", { query: "x" }), ctx);
    expect(res.ok).toBe(true); // still not a throw: a failed search is not a failed run
    const data = res.data as { results: unknown[]; note: string; searched: boolean };
    expect(data.results).toEqual([]);
    // This used to read "the query may have no hits or DuckDuckGo's markup
    // changed", which asks the model to guess which. Those call for opposite
    // actions, so the note now commits to one.
    expect(data.searched).toBe(false);
    expect(data.note).toMatch(/did NOT run/);
    expect(data.note).not.toMatch(/may have no hits/);
  });

  it("maps HTTP errors to a search_failed ToolError", async () => {
    fetchReturning("", 503);
    const dispatcher = createDefaultDispatcher();
    const ctx = makeCtx(makeWorkspace(), { confirm: async () => true });
    const res = await dispatcher.execute(call("web_search", { query: "x" }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("search_failed");
  });

  it("aborts an in-flight search when the agent run is cancelled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }) as unknown as typeof fetch,
    );
    const controller = new AbortController();
    const dispatcher = createDefaultDispatcher();
    const ctx = makeCtx(makeWorkspace(), { confirm: async () => true, signal: controller.signal });

    const pending = dispatcher.execute(call("web_search", { query: "x" }), ctx);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();

    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "cancelled" } });
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

  /**
   * The backend chain. web_search had exactly one provider and no way to add
   * another, so a DuckDuckGo markup change or block page silently emptied every
   * search in every workspace — and reported it in the same words as a query
   * that genuinely had no hits.
   */
  describe("backends", () => {
    /** Answers each request by URL, so a chain can be scripted end to end. */
    function fetchByUrl(handler: (url: string) => { body: string; status?: number }): ReturnType<typeof vi.fn> {
      const spy = vi.fn(async (input: unknown) => {
        const url = String(input);
        const { body, status = 200 } = handler(url);
        return new Response(body, { status, headers: { "content-type": "text/html" } });
      });
      vi.stubGlobal("fetch", spy as unknown as typeof fetch);
      return spy;
    }

    const searxngBody = (n: number): string =>
      JSON.stringify({
        results: Array.from({ length: n }, (_, i) => ({
          title: `S${i}`,
          url: `https://searx.example/${i}`,
          content: "from searxng",
        })),
      });

    async function search(workspace: string, query = "node docs"): Promise<Awaited<ReturnType<typeof run>>> {
      return run(workspace, query);
    }
    async function run(workspace: string, query: string) {
      const dispatcher = createDefaultDispatcher();
      const { confirm } = scriptedConfirm(true);
      const ctx = makeCtx(workspace, { policy: { approvalMode: "auto" }, confirm });
      return dispatcher.execute(call("web_search", { query }), ctx);
    }

    afterEach(() => {
      configureWebSearch(undefined);
    });

    it("uses only DuckDuckGo when nothing is configured", async () => {
      const spy = fetchByUrl(() => ({ body: DDG_FIXTURE }));
      const res = await search(makeWorkspace());
      expect(res.ok).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toContain("duckduckgo.com");
    });

    it("prefers a configured SearXNG instance and never calls DuckDuckGo", async () => {
      const workspace = makeWorkspace();
      configureWebSearch({ searxngUrl: "https://searx.example" }, workspace);
      const spy = fetchByUrl((url) => ({ body: url.includes("searx.example") ? searxngBody(2) : DDG_FIXTURE }));
      const res = await search(workspace);
      expect(res.ok).toBe(true);
      const data = res.data as { results: { url: string }[] };
      expect(data.results[0]?.url).toBe("https://searx.example/0");
      expect(spy).toHaveBeenCalledTimes(1); // no pointless second search
    });

    it("falls back to DuckDuckGo when the primary did not actually run", async () => {
      const workspace = makeWorkspace();
      configureWebSearch({ searxngUrl: "https://searx.example" }, workspace);
      // An instance that answers with HTML (misconfigured, or a login wall) is
      // a backend that did not run — exactly the case a second leg exists for.
      const spy = fetchByUrl((url) => ({
        body: url.includes("searx.example") ? "<html>login required</html>" : DDG_FIXTURE,
      }));
      const res = await search(workspace);
      expect(res.ok).toBe(true);
      expect(spy).toHaveBeenCalledTimes(2);
      const data = res.data as { results: { url: string }[]; note: string };
      expect(data.results[0]?.url).toBe("https://nodejs.org/docs");
      expect(data.note).toContain("searxng, duckduckgo");
    });

    it("does not second-guess a backend that ran and found nothing", async () => {
      const workspace = makeWorkspace();
      configureWebSearch({ searxngUrl: "https://searx.example" }, workspace);
      const spy = fetchByUrl(() => ({ body: searxngBody(0) }));
      const res = await search(workspace);
      expect(res.ok).toBe(true);
      // Zero hits is an answer. Asking a second provider to disagree would turn
      // it into noise.
      expect(spy).toHaveBeenCalledTimes(1);
      const data = res.data as { results: unknown[]; note: string; searched: boolean };
      expect(data.results).toEqual([]);
      expect(data.searched).toBe(true);
      expect(data.note).toMatch(/matched nothing/i);
    });

    it("says the search did not run when the provider blocked it", async () => {
      const spy = fetchByUrl(() => ({ body: "<html><body>unusual traffic detected</body></html>" }));
      const res = await search(makeWorkspace());
      expect(res.ok).toBe(true);
      const data = res.data as { results: unknown[]; note: string; searched: boolean };
      expect(data.results).toEqual([]);
      // The distinction the model has to act on: this is NOT "no such thing".
      expect(data.searched).toBe(false);
      expect(data.note).toMatch(/did NOT run/);
      expect(data.note).toMatch(/block\/captcha/);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("keeps one workspace's search endpoint out of another's", async () => {
      // The server runs several workspaces in one process; a configured
      // endpoint is one workspace's, the same way its vision endpoint is.
      const configured = makeWorkspace();
      const other = makeWorkspace();
      configureWebSearch({ searxngUrl: "https://searx.example" }, configured);
      const spy = fetchByUrl((url) => ({ body: url.includes("searx.example") ? searxngBody(1) : DDG_FIXTURE }));
      await search(other);
      expect(String(spy.mock.calls[0]?.[0])).toContain("duckduckgo.com");
    });

    it("reports every backend it tried when they all fail", async () => {
      const workspace = makeWorkspace();
      configureWebSearch({ searxngUrl: "https://searx.example" }, workspace);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("network down");
        }) as unknown as typeof fetch,
      );
      const res = await search(workspace);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("search_failed");
      expect(res.error?.message).toContain("searxng, duckduckgo");
    });
  });
});
