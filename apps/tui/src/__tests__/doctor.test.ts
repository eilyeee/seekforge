import { describe, expect, it } from "vitest";
import { formatDoctorLines, runDoctor, type DoctorCheck, type DoctorProbes } from "../doctor.js";

/** Probes describing a fully healthy darwin environment. */
function healthyProbes(over: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    env: (key) => (key === "EDITOR" ? "vim" : undefined),
    fileExists: () => true,
    nodeVersion: () => "v22.4.0",
    platform: () => "darwin",
    commandExists: (bin) => bin === "pbcopy",
    countDir: () => 3,
    ...over,
  };
}

const healthyConfig = {
  apiKey: "sk-test",
  runtimeBin: "/usr/local/bin/seekforge-runtime",
  mcpServers: { context7: {} },
};

function byName(checks: DoctorCheck[], name: string): DoctorCheck {
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`no check named "${name}"`);
  return found;
}

describe("runDoctor", () => {
  it("reports all-ok in a healthy environment", () => {
    const checks = runDoctor("/proj", healthyConfig, healthyProbes());
    expect(checks.length).toBe(11);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(byName(checks, "node").detail).toContain("v22.4.0");
    expect(byName(checks, "platform").detail).toBe("darwin");
    expect(byName(checks, "mcp servers").detail).toBe("1 configured");
    expect(byName(checks, "sessions").detail).toBe("3 recorded");
    expect(byName(checks, "editor").detail).toBe("vim");
    expect(byName(checks, "clipboard").detail).toBe("pbcopy");
  });

  it("fails the api key check when no key is configured", () => {
    const checks = runDoctor("/proj", { ...healthyConfig, apiKey: undefined }, healthyProbes());
    const check = byName(checks, "api key");
    expect(check.ok).toBe(false);
    expect(check.fixHint).toContain("DEEPSEEK_API_KEY");
  });

  it("fails the node check below version 20", () => {
    const checks = runDoctor("/proj", healthyConfig, healthyProbes({ nodeVersion: () => "v18.19.0" }));
    const check = byName(checks, "node");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("v18.19.0");
  });

  it("treats a missing project config as ok with global defaults", () => {
    const probes = healthyProbes({
      fileExists: (path) => !path.endsWith("config.json"),
    });
    const check = byName(runDoctor("/proj", healthyConfig, probes), "project config");
    expect(check.ok).toBe(true);
    expect(check.detail).toBe("using global defaults");
  });

  it("treats an unset runtime binary as ok (TS fallback)", () => {
    const config = { apiKey: "sk-test" };
    const check = byName(runDoctor("/proj", config, healthyProbes()), "rust runtime");
    expect(check.ok).toBe(true);
    expect(check.detail).toBe("not configured (TS fallback)");
  });

  it("fails the runtime check when the configured binary is missing", () => {
    const probes = healthyProbes({ fileExists: (path) => !path.includes("seekforge-runtime") });
    const check = byName(runDoctor("/proj", healthyConfig, probes), "rust runtime");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("not found");
  });

  it("keeps zero MCP servers and a missing sessions dir ok", () => {
    const checks = runDoctor("/proj", { apiKey: "k" }, healthyProbes({ countDir: () => null }));
    expect(byName(checks, "mcp servers")).toEqual({ name: "mcp servers", ok: true, detail: "0 configured" });
    expect(byName(checks, "sessions")).toEqual({ name: "sessions", ok: true, detail: "no sessions yet" });
  });

  it("flags missing git repo, memory file, editor, and clipboard", () => {
    const probes = healthyProbes({
      fileExists: () => false,
      env: () => undefined,
      commandExists: () => false,
    });
    const checks = runDoctor("/proj", healthyConfig, probes);
    for (const name of ["git repo", "project memory", "editor", "clipboard"]) {
      expect(byName(checks, name).ok).toBe(false);
    }
  });

  it("falls back to $VISUAL when $EDITOR is unset", () => {
    const probes = healthyProbes({ env: (key) => (key === "VISUAL" ? "code" : undefined) });
    expect(byName(runDoctor("/proj", healthyConfig, probes), "editor").detail).toBe("code");
  });

  it("probes linux clipboard tools on non-darwin platforms", () => {
    const probes = healthyProbes({
      platform: () => "linux",
      commandExists: (bin) => bin === "xclip",
    });
    expect(byName(runDoctor("/proj", healthyConfig, probes), "clipboard").detail).toBe("xclip");
  });
});

describe("formatDoctorLines", () => {
  it("renders ✓/✗ lines with aligned names and a summary", () => {
    const lines = formatDoctorLines([
      { name: "api key", ok: true, detail: "configured" },
      { name: "node", ok: false, detail: "v18.0.0 — SeekForge requires node >= 20" },
    ]);
    expect(lines).toEqual([
      "✓ api key  configured",
      "✗ node     v18.0.0 — SeekForge requires node >= 20",
      "1/2 checks passed",
    ]);
  });

  it("summarizes an all-passing run", () => {
    const lines = formatDoctorLines([{ name: "platform", ok: true, detail: "darwin" }]);
    expect(lines.at(-1)).toBe("1/1 checks passed");
  });
});
