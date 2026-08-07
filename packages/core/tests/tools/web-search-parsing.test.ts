import { describe, expect, it } from "vitest";
import {
  classifySearchPage,
  decodeDdgUrl,
  parseDdgResults,
  parseSearxngResults,
} from "../../src/tools/builtins/web.js";

/**
 * The DuckDuckGo result parser: the least-covered code inside the "critical"
 * coverage gate, and the code in it that reads REMOTE HTML.
 *
 * Everything here arrives from a search-results page: the href the agent will
 * be handed, the title it will read back, the snippet it may quote. The parser
 * cannot trust any of it, and it must not throw — a search that returns garbage
 * has to degrade to "no results", not fail the run.
 */

/** One result row in the shape the real page emits. */
function row(href: string, title: string, snippet = "a snippet"): string {
  return `
    <div class="result results_links">
      <a rel="nofollow" class="result__a" href="${href}">${title}</a>
      <a class="result__snippet" href="${href}">${snippet}</a>
    </div>`;
}

describe("decodeDdgUrl", () => {
  it("unwraps the redirect DuckDuckGo actually emits", () => {
    expect(decodeDdgUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x")).toBe("https://example.com/a");
    expect(decodeDdgUrl("/l/?uddg=https%3A%2F%2Fexample.com%2Fb")).toBe("https://example.com/b");
  });

  it("passes through a direct https result", () => {
    expect(decodeDdgUrl("https://example.com/direct")).toBe("https://example.com/direct");
  });

  it("refuses every scheme that is not http(s)", () => {
    // This url is handed to the agent as a result it may then fetch or show.
    // A javascript: or data: target reaching that point is the whole risk of
    // parsing someone else's page.
    for (const hostile of [
      "javascript:alert(1)",
      "/l/?uddg=javascript%3Aalert(1)",
      "/l/?uddg=data%3Atext%2Fhtml%2C%3Cscript%3E",
      "/l/?uddg=file%3A%2F%2F%2Fetc%2Fpasswd",
      "data:text/html,<script>",
      "file:///etc/passwd",
    ]) {
      expect(decodeDdgUrl(hostile), hostile).toBeUndefined();
    }
  });

  it("returns undefined rather than throwing on junk", () => {
    for (const junk of ["", "   ", "not a url", "http://", "///", "%%%"]) {
      expect(decodeDdgUrl(junk), junk).toBeUndefined();
    }
  });

  it("drops DuckDuckGo's own links when they carry no target", () => {
    // Ad and settings rows resolve to duckduckgo.com itself; passing them on as
    // "results" would be noise the agent then spends a fetch on.
    expect(decodeDdgUrl("https://duckduckgo.com/y.js?ad=1")).toBeUndefined();
    expect(decodeDdgUrl("https://links.duckduckgo.com/settings")).toBeUndefined();
    // …but a real target wrapped by duckduckgo is still a real target.
    expect(decodeDdgUrl("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fc")).toBe("https://example.com/c");
  });
});

describe("parseDdgResults", () => {
  it("reads title, url and snippet out of a results page", () => {
    const html = row("https://example.com/a", "First result") + row("https://example.com/b", "Second result");
    expect(parseDdgResults(html, 10)).toEqual([
      { title: "First result", url: "https://example.com/a", snippet: "a snippet" },
      { title: "Second result", url: "https://example.com/b", snippet: "a snippet" },
    ]);
  });

  it("honors the limit", () => {
    const html = Array.from({ length: 20 }, (_, i) => row(`https://example.com/${i}`, `R${i}`)).join("");
    expect(parseDdgResults(html, 3)).toHaveLength(3);
    expect(parseDdgResults(html, 0)).toEqual([]);
  });

  it("keeps one row per url", () => {
    const html = row("https://example.com/same", "One") + row("https://example.com/same", "Two");
    expect(parseDdgResults(html, 10)).toHaveLength(1);
  });

  it("strips markup and entities out of the text it hands back", () => {
    // The title reaches the model. Markup left in it is at best noise and at
    // worst something that reads like structure the model should obey.
    const html = row("https://example.com/x", "<b>Bold</b> &amp; &#x27;quoted&#x27;", "<i>snip</i>&nbsp;pet");
    expect(parseDdgResults(html, 5)[0]).toEqual({
      title: "Bold & 'quoted'",
      url: "https://example.com/x",
      snippet: "snip pet",
    });
  });

  it("skips a row whose href is not a usable target, keeping the rest", () => {
    const html =
      row("javascript:alert(1)", "Hostile") +
      row("https://example.com/good", "Good") +
      row("https://duckduckgo.com/y.js?ad=1", "An ad");
    expect(parseDdgResults(html, 10)).toEqual([
      { title: "Good", url: "https://example.com/good", snippet: "a snippet" },
    ]);
  });

  it("skips a row with no title rather than emitting a blank one", () => {
    const html = `<a class="result__a" href="https://example.com/x"></a>` + row("https://example.com/y", "Real");
    expect(parseDdgResults(html, 10).map((r) => r.url)).toEqual(["https://example.com/y"]);
  });

  it("returns [] instead of throwing when the layout is not what it expects", () => {
    // "Robust to markup drift" is the documented contract: DuckDuckGo can
    // change its HTML any day, and a search that finds nothing must not be a
    // failed tool call.
    for (const html of ["", "<html><body>nothing here</body></html>", "<a href=", "&&&", '<a class="result__a">']) {
      expect(() => parseDdgResults(html, 5)).not.toThrow();
      expect(parseDdgResults(html, 5)).toEqual([]);
    }
  });

  it("tolerates a row whose snippet is missing", () => {
    const html = `<a rel="nofollow" class="result__a" href="https://example.com/z">Title only</a>`;
    expect(parseDdgResults(html, 5)).toEqual([{ title: "Title only", url: "https://example.com/z", snippet: "" }]);
  });
});

describe("classifySearchPage", () => {
  /**
   * The tool used to answer "No results parsed — the query may have no hits or
   * DuckDuckGo's markup changed." for three different situations. Those call
   * for opposite actions: "no hits" is an answer the model should believe,
   * while drift and a block page mean the search never ran and believing it
   * would be inventing a negative result.
   */
  it("calls a page with rows a results page", () => {
    expect(classifySearchPage(row("https://example.com/a", "R"), 1)).toBe("results");
  });

  it("separates a genuine zero-hit page from markup drift", () => {
    const noHits = '<div class="no-results">No results found for that query.</div>';
    expect(classifySearchPage(noHits, 0)).toBe("empty");
    // A page that still looks like the results shell but parsed nothing is the
    // parser falling behind the markup, not an empty result set.
    expect(classifySearchPage('<div class="results_links"><a class="totally_new">x</a></div>', 0)).toBe("drift");
    // And something that is not the page at all.
    expect(classifySearchPage("<html><body>hello</body></html>", 0)).toBe("drift");
  });

  it("recognizes the block/captcha interstitial", () => {
    for (const body of [
      "<html><body>If this error persists, please let us know: anomaly detected</body></html>",
      '<form class="challenge-form">solve the captcha</form>',
      "<p>Our systems have detected unusual traffic</p>",
    ]) {
      expect(classifySearchPage(body, 0), body).toBe("blocked");
    }
  });

  it("prefers the block verdict over drift when the page has both", () => {
    // A block page can still carry the results shell markup around it; the
    // block is the actionable fact.
    expect(classifySearchPage('<div class="results_links"></div><div>captcha</div>', 0)).toBe("blocked");
  });
});

describe("parseSearxngResults", () => {
  const body = (results: unknown): string => JSON.stringify({ results });

  it("reads title, url and snippet out of a SearXNG JSON response", () => {
    expect(
      parseSearxngResults(body([{ title: "First", url: "https://example.com/a", content: "a snippet" }]), 10),
    ).toEqual([{ title: "First", url: "https://example.com/a", snippet: "a snippet" }]);
  });

  it("applies the same http(s)-only filter the HTML path does", () => {
    // A self-hosted instance is still relaying results from upstream engines,
    // so its output is no more trustworthy than the scraped page.
    const rows = [
      { title: "Hostile", url: "javascript:alert(1)", content: "" },
      { title: "Local", url: "file:///etc/passwd", content: "" },
      { title: "Good", url: "https://example.com/good", content: "ok" },
    ];
    expect(parseSearxngResults(body(rows), 10).map((r) => r.url)).toEqual(["https://example.com/good"]);
  });

  it("honors the limit and keeps one row per url", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ title: `R${i}`, url: `https://example.com/${i}` }));
    expect(parseSearxngResults(body(rows), 3)).toHaveLength(3);
    const dupes = [
      { title: "One", url: "https://example.com/same" },
      { title: "Two", url: "https://example.com/same" },
    ];
    expect(parseSearxngResults(body(dupes), 10)).toHaveLength(1);
  });

  it("returns [] rather than throwing on anything unexpected", () => {
    for (const junk of ["", "not json", "null", "[]", '{"results":null}', '{"results":[1,2,"x"]}', '{"other":1}']) {
      expect(() => parseSearxngResults(junk, 5), junk).not.toThrow();
      expect(parseSearxngResults(junk, 5), junk).toEqual([]);
    }
    // Rows missing the fields that make a result usable are skipped, not faked.
    expect(
      parseSearxngResults(JSON.stringify({ results: [{ url: "https://e.com" }, { title: "no url" }] }), 5),
    ).toEqual([]);
  });
});
