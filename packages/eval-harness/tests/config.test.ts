import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEvalConfig } from "../src/config.js";

/** Restore env keys we mutate so tests stay independent. */
const KEYS = ["ARK_API_KEY", "DEEPSEEK_API_KEY"] as const;

describe("loadEvalConfig", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /** A project dir whose .seekforge/config.json holds the given fields. */
  function projectWithConfig(config: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "eval-config-"));
    mkdirSync(join(dir, ".seekforge"), { recursive: true });
    writeFileSync(join(dir, ".seekforge", "config.json"), JSON.stringify(config));
    return dir;
  }

  it("prefers ARK_API_KEY over DEEPSEEK_API_KEY", () => {
    process.env["ARK_API_KEY"] = "sk-ark";
    process.env["DEEPSEEK_API_KEY"] = "sk-deepseek";
    expect(loadEvalConfig(projectWithConfig({ apiKey: "from-file" })).apiKey).toBe("sk-ark");
  });

  it("still uses DEEPSEEK_API_KEY when ARK_API_KEY is unset", () => {
    process.env["DEEPSEEK_API_KEY"] = "sk-deepseek";
    expect(loadEvalConfig(projectWithConfig({ apiKey: "from-file" })).apiKey).toBe("sk-deepseek");
  });

  it("falls back to config.json apiKey when no env key is set", () => {
    expect(loadEvalConfig(projectWithConfig({ apiKey: "from-file" })).apiKey).toBe("from-file");
  });

  it("reads the provider preset from config.json", () => {
    expect(loadEvalConfig(projectWithConfig({ provider: "ark" })).provider).toBe("ark");
  });
});
