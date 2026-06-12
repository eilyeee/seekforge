import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { needsOnboarding, saveGlobalApiKey, validateApiKeyFormat } from "../onboarding.js";

describe("needsOnboarding", () => {
  it("is true when no apiKey is configured", () => {
    expect(needsOnboarding({})).toBe(true);
    expect(needsOnboarding({ apiKey: "" })).toBe(true);
  });

  it("is false when an apiKey is present", () => {
    expect(needsOnboarding({ apiKey: "sk-abcdefghijklmnopqrstuvwx" })).toBe(false);
  });
});

describe("validateApiKeyFormat", () => {
  it("rejects empty / whitespace-only input", () => {
    expect(validateApiKeyFormat("")).toMatch(/empty/i);
    expect(validateApiKeyFormat("   ")).toMatch(/empty/i);
  });

  it("rejects keys with whitespace inside", () => {
    expect(validateApiKeyFormat("sk-abcdef ghijklmnopqrstuvwx")).toMatch(/whitespace/i);
  });

  it("rejects keys that are too short", () => {
    expect(validateApiKeyFormat("sk-short")).toMatch(/short/i);
  });

  it("rejects keys that are too long", () => {
    expect(validateApiKeyFormat(`sk-${"a".repeat(220)}`)).toMatch(/long/i);
  });

  it("accepts a plausible key, trimming surrounding spaces", () => {
    expect(validateApiKeyFormat("  sk-abcdefghijklmnopqrstuvwx  ")).toBeNull();
    expect(validateApiKeyFormat("sk-abcdefghijklmnopqrstuvwx")).toBeNull();
  });
});

describe("saveGlobalApiKey", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "seekforge-onboarding-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("creates dir and file from scratch and returns the path", () => {
    const key = "sk-abcdefghijklmnopqrstuvwx";
    const { path } = saveGlobalApiKey(key, home);
    expect(path).toBe(join(home, ".seekforge", "config.json"));
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(parsed).toEqual({ apiKey: key });
  });

  it("trims the key before writing", () => {
    const { path } = saveGlobalApiKey("  sk-abcdefghijklmnopqrstuvwx  ", home);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(parsed["apiKey"]).toBe("sk-abcdefghijklmnopqrstuvwx");
  });

  it("merges over an existing config.json, preserving other fields", () => {
    const dir = join(home, ".seekforge");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ model: "deepseek-reasoner", bell: false }));
    const { path } = saveGlobalApiKey("sk-abcdefghijklmnopqrstuvwx", home);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(parsed).toEqual({
      model: "deepseek-reasoner",
      bell: false,
      apiKey: "sk-abcdefghijklmnopqrstuvwx",
    });
  });

  it("overwrites a previously saved apiKey", () => {
    saveGlobalApiKey("sk-oldoldoldoldoldoldoldold", home);
    const { path } = saveGlobalApiKey("sk-newnewnewnewnewnewnewnew", home);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(parsed["apiKey"]).toBe("sk-newnewnewnewnewnewnewnew");
  });

  it("writes the file with owner-only permissions (0600)", () => {
    const { path } = saveGlobalApiKey("sk-abcdefghijklmnopqrstuvwx", home);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("recovers from a corrupt existing config.json", () => {
    const dir = join(home, ".seekforge");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{ not json");
    const { path } = saveGlobalApiKey("sk-abcdefghijklmnopqrstuvwx", home);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(parsed).toEqual({ apiKey: "sk-abcdefghijklmnopqrstuvwx" });
  });
});
