import { describe, expect, it } from "vitest";
import { needsOnboarding, validateApiKeyFormat } from "./onboarding";

describe("needsOnboarding", () => {
  it("is true when no key is configured", () => {
    expect(needsOnboarding({})).toBe(true);
    expect(needsOnboarding({ apiKey: "" })).toBe(true);
    expect(needsOnboarding({ apiKey: "   " })).toBe(true);
  });

  it("is false once a (masked) key is present", () => {
    expect(needsOnboarding({ apiKey: "sk-xxxx****" })).toBe(false);
  });
});

describe("validateApiKeyFormat", () => {
  it("rejects empty / whitespace-only", () => {
    expect(validateApiKeyFormat("")).toMatch(/empty/);
    expect(validateApiKeyFormat("   ")).toMatch(/empty/);
  });

  it("rejects keys with inner whitespace", () => {
    expect(validateApiKeyFormat("sk-abc def ghijklmnopqrstuv")).toMatch(/whitespace/);
  });

  it("rejects too-short and too-long keys", () => {
    expect(validateApiKeyFormat("sk-short")).toMatch(/too short/);
    expect(validateApiKeyFormat(`sk-${"x".repeat(300)}`)).toMatch(/too long/);
  });

  it("accepts a plausible key (trimmed)", () => {
    expect(validateApiKeyFormat("  sk-1234567890abcdefghij  ")).toBeNull();
  });
});
