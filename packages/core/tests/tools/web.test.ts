import { describe, expect, it } from "vitest";
import { ToolError } from "../../src/tools/errors.js";
import { checkFetchUrl, htmlToText } from "../../src/tools/builtins/web.js";

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
