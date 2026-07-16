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

  function projectWithRawConfig(config: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "eval-config-"));
    mkdirSync(join(dir, ".seekforge"), { recursive: true });
    writeFileSync(join(dir, ".seekforge", "config.json"), JSON.stringify(config));
    return dir;
  }

  it("a default (DeepSeek) config with both env keys set uses DEEPSEEK_API_KEY", () => {
    // No provider => default deepseek: the Ark key exported for another tool
    // must NOT be sent to the DeepSeek endpoint.
    process.env["ARK_API_KEY"] = "sk-ark";
    process.env["DEEPSEEK_API_KEY"] = "sk-deepseek";
    expect(loadEvalConfig(projectWithConfig({ apiKey: "from-file" })).apiKey).toBe("sk-deepseek");
  });

  it("an ark config with both env keys set uses ARK_API_KEY", () => {
    process.env["ARK_API_KEY"] = "sk-ark";
    process.env["DEEPSEEK_API_KEY"] = "sk-deepseek";
    expect(loadEvalConfig(projectWithConfig({ provider: "ark", apiKey: "from-file" })).apiKey).toBe("sk-ark");
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

  it("ignores non-object and wrongly typed config values", () => {
    const inherited = loadEvalConfig(projectWithConfig({}));
    expect(loadEvalConfig(projectWithRawConfig(null))).toEqual(inherited);
    expect(loadEvalConfig(projectWithConfig({ provider: 42, apiKey: ["not-a-key"] }))).toEqual(inherited);
  });

  it("keeps only finite non-negative model pricing entries", () => {
    const config = loadEvalConfig(
      projectWithConfig({
        modelPricing: {
          valid: { inputCacheMissPer1M: 1, inputCacheHitPer1M: 0, outputPer1M: 2 },
          negative: { inputCacheMissPer1M: -1, inputCacheHitPer1M: 0, outputPer1M: 2 },
          missing: { inputCacheMissPer1M: 1, outputPer1M: 2 },
        },
      }),
    );
    expect(config.modelPricing).toEqual({
      valid: { inputCacheMissPer1M: 1, inputCacheHitPer1M: 0, outputPer1M: 2 },
    });
  });
});
