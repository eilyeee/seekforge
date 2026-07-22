import { describe, expect, it } from "vitest";
import { COMMON_CONFIG_KEYS, knownConfigKeys } from "../src/config-manifest.js";
import { SEEKFORGE_PROTOCOL_VERSION, SERVER_CAPABILITIES, SERVER_FEATURES } from "../src/features.js";

describe("shared manifests", () => {
  it("keeps common config keys visible to every surface", () => {
    for (const surface of ["cli", "tui", "server"] as const) {
      const keys = knownConfigKeys(surface);
      for (const key of COMMON_CONFIG_KEYS) expect(keys.has(key)).toBe(true);
    }
  });

  it("keeps surface-only config keys scoped", () => {
    expect(knownConfigKeys("cli").has("profiles")).toBe(true);
    expect(knownConfigKeys("tui").has("profiles")).toBe(false);
    expect(knownConfigKeys("tui").has("statusLine")).toBe(true);
    expect(knownConfigKeys("server").has("models")).toBe(true);
  });

  it("derives unique wire capabilities from the feature manifest", () => {
    expect(SEEKFORGE_PROTOCOL_VERSION).toBeGreaterThan(0);
    expect(SERVER_CAPABILITIES).toEqual(SERVER_FEATURES.map((feature) => feature.id));
    expect(new Set(SERVER_CAPABILITIES).size).toBe(SERVER_CAPABILITIES.length);
  });
});
