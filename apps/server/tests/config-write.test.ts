import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigValueError, loadConfig, setConfigValue } from "../src/config.js";
import { makeWorkspace } from "./helpers.js";

describe("setConfigValue (project) durability", () => {
  it("round-trips a value and preserves other keys", () => {
    const ws = makeWorkspace();
    setConfigValue(ws, "model", "deepseek-v4", false);
    setConfigValue(ws, "baseUrl", "https://example.test", false);
    const cfg = loadConfig(ws);
    expect(cfg.model).toBe("deepseek-v4");
    expect(cfg.baseUrl).toBe("https://example.test");
  });

  it("refuses to overwrite a malformed config instead of wiping the user's other keys", () => {
    const ws = makeWorkspace();
    setConfigValue(ws, "model", "keep-me", false);
    const path = join(ws, ".seekforge", "config.json");
    // Simulate a half-written / hand-corrupted file.
    writeFileSync(path, '{ "model": "keep-me", ');
    expect(() => setConfigValue(ws, "baseUrl", "https://x", false)).toThrow(ConfigValueError);
    // The corrupt file is left untouched — not silently replaced from empty.
    expect(readFileSync(path, "utf8")).toContain("keep-me");
  });
});
