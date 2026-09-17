import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiKeyHelperFor, clearApiKeyHelperCache } from "../src/api-key-helper.js";
import {
  type BaseConfigShape,
  type ConfigLayer,
  describeConfigMergeReport,
  mergeConfigLayers,
  mergeConfigLayersWithReport,
  repositoryConfigLayer,
  sanitizeProjectConfig,
  userConfigLayer,
} from "../src/config-layers.js";

let dir: string;

/** A helper that prints `key` and leaves a marker file proving it ran. */
function helper(key: string, exit = 0): { command: string; ran: () => boolean } {
  const marker = join(dir, `ran-${key}`);
  const script = join(dir, `print-${key}.cjs`);
  writeFileSync(
    script,
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "");
console.log(${JSON.stringify(key)}); process.exitCode = ${exit};`,
  );
  return { command: `"${process.execPath}" "${script}"`, ran: () => existsSync(marker) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sf-merge-helper-"));
  clearApiKeyHelperCache();
  for (const name of ["DEEPSEEK_API_KEY", "ARK_API_KEY", "ANTHROPIC_API_KEY"]) vi.stubEnv(name, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearApiKeyHelperCache();
  rmSync(dir, { recursive: true, force: true });
});

describe("apiKeyHelper in the config merge", { timeout: 30_000 }, () => {
  it("fills apiKey from a user layer's helper, above the file's own key", () => {
    const h = helper("sk-from-helper");
    const config = mergeConfigLayers<BaseConfigShape>([
      userConfigLayer({ apiKey: "sk-static", apiKeyHelper: h.command }),
      repositoryConfigLayer({}),
    ]);
    expect(config.apiKey).toBe("sk-from-helper");
    expect(config.apiKeyHelper).toBe(h.command);
    expect(apiKeyHelperFor("sk-from-helper")).toBe(h.command);
  });

  it("never runs a helper a repository layer names", () => {
    const h = helper("sk-repo");
    expect(sanitizeProjectConfig({ apiKeyHelper: h.command })).toEqual({});
    const sanitized = mergeConfigLayers<BaseConfigShape>([
      userConfigLayer({ apiKey: "sk-user" }),
      repositoryConfigLayer({ apiKeyHelper: h.command }),
    ]);
    // A layer tagged by hand, without the sanitizer, is refused on its origin.
    const handTagged: ConfigLayer<BaseConfigShape> = { origin: "repository", config: { apiKeyHelper: h.command } };
    const tagged = mergeConfigLayers<BaseConfigShape>([userConfigLayer({ apiKey: "sk-user" }), handTagged]);
    for (const config of [sanitized, tagged]) {
      expect(config.apiKey).toBe("sk-user");
      expect(config).not.toHaveProperty("apiKeyHelper");
    }
    expect(h.ran()).toBe(false);
  });

  it("lets the provider's own variable win without running the helper", () => {
    const h = helper("sk-helper");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
    const config = mergeConfigLayers<BaseConfigShape>([
      userConfigLayer({ provider: "anthropic", apiKeyHelper: h.command }),
    ]);
    expect(config.apiKey).toBe("sk-env");
    expect(h.ran()).toBe(false);
  });

  it("does not run the helper in an env-free sub-merge", () => {
    const h = helper("sk-helper");
    const config = mergeConfigLayers<BaseConfigShape>([userConfigLayer({ apiKeyHelper: h.command })], {
      envOverrides: false,
    });
    expect(config.apiKeyHelper).toBe(h.command);
    expect(config).not.toHaveProperty("apiKey");
    expect(h.ran()).toBe(false);
  });

  it("reports a failed helper and leaves no key rather than the file's", () => {
    const h = helper("sk-leaked", 2);
    const { config, report } = mergeConfigLayersWithReport<BaseConfigShape>([
      userConfigLayer({ apiKey: "sk-static", apiKeyHelper: h.command }),
    ]);
    expect(config).not.toHaveProperty("apiKey");
    expect(report.apiKeyHelperError).toMatch(/^apiKeyHelper exited with code 2/);
    const lines = describeConfigMergeReport(report);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("no API key is configured");
    expect(lines.join("")).not.toContain("sk-leaked");
  });

  it("ignores a helper that is not a non-empty string", () => {
    for (const apiKeyHelper of ["", "   ", 42, null]) {
      const config = mergeConfigLayers<BaseConfigShape>([
        userConfigLayer({ apiKey: "sk-static", apiKeyHelper } as BaseConfigShape),
      ]);
      expect(config.apiKey).toBe("sk-static");
      expect(config).not.toHaveProperty("apiKeyHelper");
    }
  });
});
