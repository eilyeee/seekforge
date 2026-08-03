import { describe, expect, it } from "vitest";
import { apiKeyEnvVar } from "../src/provider-env.js";

/**
 * A key is scoped to the endpoint that issued it, so which variable is read has
 * to depend on which provider is configured — otherwise a key exported for one
 * tool is sent to another vendor's API.
 */
describe("which env var holds a provider's key", () => {
  it("gives a provider its own variable when it has one", () => {
    expect(apiKeyEnvVar("ark")).toBe("ARK_API_KEY");
    expect(apiKeyEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(apiKeyEnvVar("Anthropic")).toBe("ANTHROPIC_API_KEY");
  });

  it("leaves every other provider on DEEPSEEK_API_KEY", () => {
    // Deliberate: those presets have always read this variable, and repointing
    // them now would break setups whose key already lives there.
    for (const provider of ["deepseek", "openai", "ollama", "openrouter", "unknown", "", undefined]) {
      expect(apiKeyEnvVar(provider)).toBe("DEEPSEEK_API_KEY");
    }
  });
});
