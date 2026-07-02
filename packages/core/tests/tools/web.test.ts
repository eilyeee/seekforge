import { describe, expect, it } from "vitest";
import { ToolError } from "../../src/tools/errors.js";
import {
  checkFetchUrl,
  extractRelevant,
  htmlToText,
  normalizeNumericIpv4,
} from "../../src/tools/builtins/web.js";

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
    // IPv4-mapped IPv6 must not smuggle a private IPv4 past the guard.
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://[::ffff:10.0.0.1]/",
    // Numeric-encoded hosts that decode to private/loopback addresses.
    "http://2130706433/", // decimal → 127.0.0.1
    "http://0177.0.0.1/", // octal octet → 127.0.0.1
    "http://0x7f.0.0.1/", // hex octet → 127.0.0.1
    "http://0x7f000001/", // bare hex → 127.0.0.1
    "http://017700000001/", // bare octal → 127.0.0.1
    "http://0/", // → 0.0.0.0
    "http://127.1/", // inet_aton short form → 127.0.0.1
    "http://192.168.257/", // 3-part form → 192.168.1.1
  ])("refuses private/loopback target: %s", (url) => {
    expect(() => checkFetchUrl(url)).toThrowError(/private|loopback|suspicious/i);
  });

  it.each([
    "http://999.999.999.999/", // octets out of range
    "http://0x100000000/", // > 32 bits
    "http://08.0.0.1/", // malformed octal octet
    "http://4294967296/", // 2^32, out of range
  ])("blocks numeric-looking but malformed/out-of-range hosts (fail closed): %s", (url) => {
    // These are refused one way or another: the WHATWG URL parser rejects the
    // out-of-range forms outright, and normalizeNumericIpv4 fails closed on any
    // that reach it — either way the fetch never proceeds.
    expect(() => checkFetchUrl(url)).toThrowError(ToolError);
  });

  it("still allows a normal public numeric IP and hostname", () => {
    expect(checkFetchUrl("http://8.8.8.8/").hostname).toBe("8.8.8.8");
    expect(checkFetchUrl("https://api-docs.deepseek.com/").hostname).toBe("api-docs.deepseek.com");
    // A public host with a digit-led label must not be mistaken for numeric.
    expect(checkFetchUrl("https://3com.com/").hostname).toBe("3com.com");
  });
});

describe("normalizeNumericIpv4 (SSRF numeric-host safety net)", () => {
  it.each([
    ["2130706433", "127.0.0.1"], // bare decimal
    ["0x7f000001", "127.0.0.1"], // bare hex
    ["017700000001", "127.0.0.1"], // bare octal
    ["0177.0.0.1", "127.0.0.1"], // octal octet
    ["0x7f.0.0.1", "127.0.0.1"], // hex octet
    ["0", "0.0.0.0"], // single zero
    ["127.1", "127.0.0.1"], // 2-part inet_aton short form
    ["192.168.257", "192.168.1.1"], // 3-part form
    ["8.8.8.8", "8.8.8.8"], // already dotted-quad, public
  ])("decodes %s to canonical %s", (host, dotted) => {
    expect(normalizeNumericIpv4(host)).toBe(dotted);
  });

  it.each([
    "999.999.999.999", // octets out of range
    "0x100000000", // > 32 bits
    "08.0.0.1", // malformed octal octet
    "4294967296", // 2^32
    "1.2.3.4.5", // too many parts is treated as non-numeric, but...
  ])("fails closed (invalid or non-numeric) on malformed host %s", (host) => {
    const out = normalizeNumericIpv4(host);
    // Never returns a usable dotted-quad for these: either "invalid" (blocked)
    // or null (5-part is not an IPv4 form at all).
    expect(out === "invalid" || out === null).toBe(true);
  });

  it("returns null for normal hostnames (leaves them for the string checks)", () => {
    expect(normalizeNumericIpv4("example.com")).toBeNull();
    expect(normalizeNumericIpv4("3com.com")).toBeNull();
    expect(normalizeNumericIpv4("localhost")).toBeNull();
  });

  it("allows 172.x outside the private range", () => {
    expect(checkFetchUrl("http://172.32.0.1/").hostname).toBe("172.32.0.1");
  });

  it("allows real hostnames that merely start with fc/fd (not IPv6 literals)", () => {
    expect(checkFetchUrl("http://fc2.com/").hostname).toBe("fc2.com");
    expect(checkFetchUrl("https://fdic.gov/").hostname).toBe("fdic.gov");
  });

  it("still refuses genuine IPv6 unique-local/link-local literals", () => {
    expect(() => checkFetchUrl("http://[fc00::1]/")).toThrowError(/private|loopback/i);
    expect(() => checkFetchUrl("http://[fe80::1]/")).toThrowError(/private|loopback/i);
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
