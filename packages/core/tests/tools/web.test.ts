import { describe, expect, it } from "vitest";
import { ToolError } from "../../src/tools/errors.js";
import { checkFetchUrl, extractRelevant, htmlToText } from "../../src/tools/builtins/web.js";

describe("checkFetchUrl", () => {
  it("accepts public http(s) urls", () => {
    expect(checkFetchUrl("https://api-docs.deepseek.com/pricing").hostname).toBe(
      "api-docs.deepseek.com",
    );
    expect(checkFetchUrl("http://example.com/a?b=c").protocol).toBe("http:");
  });

  it.each([
    "ftp://example.com/file",
    "file:///etc/passwd",
    "not a url",
  ])("rejects non-http(s): %s", (url) => {
    expect(() => checkFetchUrl(url)).toThrowError(ToolError);
  });

  it.each([
    "http://localhost:3000/",
    "http://127.0.0.1/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://10.1.2.3/",
    "http://192.168.1.1/admin",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://169.254.169.254/latest/meta-data/",
    "http://router.local/",
  ])("refuses private/loopback target: %s", (url) => {
    expect(() => checkFetchUrl(url)).toThrowError(/private|loopback/i);
  });

  it("allows 172.x outside the private range", () => {
    expect(checkFetchUrl("http://172.32.0.1/").hostname).toBe("172.32.0.1");
  });
});

describe("htmlToText", () => {
  it("strips scripts, styles, and tags but keeps readable text", () => {
    const html = `<html><head><style>body{color:red}</style>
      <script>alert("x")</script></head>
      <body><h1>Title</h1><p>Hello &amp; welcome</p><ul><li>one</li><li>two</li></ul></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("Title");
    expect(text).toContain("Hello & welcome");
    expect(text).toContain("one");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("<p>");
  });
});

describe("extractRelevant", () => {
  it("returns text unchanged when under the cap", () => {
    const res = extractRelevant("short text", "anything", 1000);
    expect(res).toEqual({ text: "short text", truncated: false });
  });

  it("keeps lines matching the extract keywords when over the cap", () => {
    const noise = Array.from({ length: 400 }, (_, i) => `noise line ${i} lorem ipsum dolor`);
    const needle = "the AUTHENTICATION token refresh endpoint is /auth/refresh";
    const lines = [...noise.slice(0, 200), needle, ...noise.slice(200)];
    const text = lines.join("\n");
    const cap = 2000;
    expect(text.length).toBeGreaterThan(cap);

    const res = extractRelevant(text, "authentication refresh", cap);
    expect(res.truncated).toBe(true);
    expect(res.text).toContain(needle);
    expect(res.text.length).toBeLessThanOrEqual(cap);
  });

  it("falls back to head+tail when no line matches", () => {
    const text = Array.from({ length: 500 }, (_, i) => `boring line number ${i}`).join("\n");
    const res = extractRelevant(text, "nonexistentkeyword", 1000);
    expect(res.truncated).toBe(true);
    expect(res.text).toContain("[truncated");
    expect(res.text.length).toBeLessThanOrEqual(1000);
  });

  it("falls back to head+tail when the query has no usable keywords", () => {
    const text = "x".repeat(5000);
    const res = extractRelevant(text, "a, b", 1000); // both < 3 chars
    expect(res.truncated).toBe(true);
    expect(res.text).toContain("[truncated");
  });
});
