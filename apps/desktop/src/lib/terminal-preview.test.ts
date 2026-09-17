import { describe, expect, it } from "vitest";
import { detectLoopbackUrls, normalizeLoopbackUrl } from "./preview-urls";
import { keyToInput, pasteToInput } from "./terminal-keys";

const ESC = String.fromCharCode(0x1b);
const key = (
  k: string,
  mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean }> = {},
) => keyToInput({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });

describe("keyToInput", () => {
  it("maps printable, named and control keys", () => {
    expect(key("a")).toBe("a");
    expect(key("中")).toBe("中");
    expect(key("Enter")).toBe("\r");
    expect(key("Backspace")).toBe(String.fromCharCode(0x7f));
    expect(key("ArrowUp")).toBe(`${ESC}[A`);
    expect(key("c", { ctrlKey: true })).toBe(String.fromCharCode(3));
    expect(key("D", { ctrlKey: true })).toBe(String.fromCharCode(4));
    expect(key("b", { altKey: true })).toBe(`${ESC}b`);
    expect(key("Tab", { shiftKey: true })).toBe(`${ESC}[Z`);
  });

  it("leaves Cmd shortcuts and unknown keys to the app", () => {
    expect(key("c", { metaKey: true })).toBeNull();
    expect(key("Shift")).toBeNull();
    expect(key("F5")).toBeNull();
    expect(key("1", { ctrlKey: true })).toBeNull();
  });

  it("turns pasted newlines into Enter", () => {
    expect(pasteToInput("ls\r\npwd\n")).toBe("ls\rpwd\r");
  });
});

describe("loopback preview URLs", () => {
  it("accepts only explicit-port loopback http(s) URLs", () => {
    expect(normalizeLoopbackUrl("http://localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeLoopbackUrl("127.0.0.1:3000/app?x=1")).toBe("http://127.0.0.1:3000/app?x=1");
    expect(normalizeLoopbackUrl(":8080")).toBe("http://localhost:8080/");
    expect(normalizeLoopbackUrl("https://[::1]:8443/")).toBe("https://[::1]:8443/");
    for (const bad of [
      "",
      "http://localhost",
      "http://example.com:80",
      "http://localhost.evil.com:80",
      "http://127.0.0.2:80",
      "http://user:pw@localhost:80",
      "file://localhost:80/etc/passwd",
      "javascript:alert(1)",
      "http://localhost:99999",
    ]) {
      expect(normalizeLoopbackUrl(bad), bad).toBeNull();
    }
  });

  it("finds dev-server URLs in command output", () => {
    const output = [
      `  ${ESC}[32m➜${ESC}[39m  Local:   ${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/${ESC}[39m`,
      "  ➜  Network: http://192.168.1.4:5173/",
      "Listening on http://0.0.0.0:3000.",
      "again http://localhost:5173/",
    ].join("\n");
    expect(detectLoopbackUrls(output)).toEqual(["http://127.0.0.1:3000/", "http://localhost:5173/"]);
    expect(detectLoopbackUrls("nothing here")).toEqual([]);
  });
});
