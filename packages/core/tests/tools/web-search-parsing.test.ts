import { describe, expect, it } from "vitest";
import { decodeDdgUrl, parseDdgResults } from "../../src/tools/builtins/web.js";

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
