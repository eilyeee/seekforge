import { browserCheck, codeParsingCheck, lspServersCheck, osSandboxCheck } from "@seekforge/shared/doctor";
import { describe, expect, it } from "vitest";
import {
  configKeysCheck,
  configParseCheck,
  formatDoctorLines,
  runDoctor,
  type DoctorCheck,
  type DoctorProbes,
} from "../doctor.js";

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
    expect(checks.length).toBe(17);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(byName(checks, "node").detail).toContain("v22.4.0");
    expect(byName(checks, "platform").detail).toBe("darwin");
    expect(byName(checks, "mcp servers").detail).toBe("1 configured");
    expect(byName(checks, "sessions").detail).toBe("3 recorded");
    expect(byName(checks, "editor").detail).toBe("vim");
    expect(byName(checks, "clipboard").detail).toBe("pbcopy");
  });

  it("defaults to the deepseek provider with its base URL", () => {
    const check = byName(runDoctor("/proj", healthyConfig, healthyProbes()), "provider");
    expect(check.ok).toBe(true);
    expect(check.detail).toBe("deepseek (https://api.deepseek.com)");
  });

  it("reports the ark provider and its base URL", () => {
    const config = { ...healthyConfig, provider: "ark" };
    const check = byName(runDoctor("/proj", config, healthyProbes()), "provider");
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("ark");
    expect(check.detail).toContain("ark.cn-beijing.volces.com");
  });

  it("honors an explicit baseUrl override in the provider line", () => {
    const config = { ...healthyConfig, provider: "ark", baseUrl: "https://custom.example.com" };
    const check = byName(runDoctor("/proj", config, healthyProbes()), "provider");
    expect(check.detail).toBe("ark (https://custom.example.com)");
  });

  it("passes the api key check for ark when ARK_API_KEY is set", () => {
    const probes = healthyProbes({ env: (key) => (key === "ARK_API_KEY" ? "sk-ark" : undefined) });
    const check = byName(runDoctor("/proj", { provider: "ark" }, probes), "api key");
    expect(check.ok).toBe(true);
    expect(check.detail).toBe("configured");
  });

  it("fails the ark api key check pointing at ARK_API_KEY when unset", () => {
    const check = byName(runDoctor("/proj", { provider: "ark" }, healthyProbes()), "api key");
    expect(check.ok).toBe(false);
    expect(check.fixHint).toContain("ARK_API_KEY");
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

describe("configKeysCheck", () => {
  it("passes when there are no unknown keys", () => {
    const check = configKeysCheck([]);
    expect(check.ok).toBe(true);
    expect(check.warn).toBeUndefined();
    expect(check.detail).toBe("all recognized");
  });

  it("warns (non-fatal) and lists unrecognized keys", () => {
    const check = configKeysCheck(["modle", "reasoningEffrt"]);
    expect(check.ok).toBe(true); // warning, not a failure — must not flip the summary
    expect(check.warn).toBe(true);
    expect(check.detail).toContain("modle");
    expect(check.detail).toContain("reasoningEffrt");
    expect(check.fixHint).toBeTruthy();
  });
});

describe("configParseCheck", () => {
  it("passes when there are no parse errors", () => {
    const check = configParseCheck([]);
    expect(check.ok).toBe(true);
    expect(check.warn).toBeUndefined();
  });

  it("fails and lists the unparseable files", () => {
    const check = configParseCheck(["/proj/.seekforge/config.json"]);
    expect(check.ok).toBe(false); // a failure — flips the summary
    expect(check.detail).toContain("/proj/.seekforge/config.json");
    expect(check.fixHint).toBeTruthy();
  });
});

describe("formatDoctorLines", () => {
  it("marks warnings with ~ and shows their fix hint", () => {
    const lines = formatDoctorLines([
      { name: "config keys", ok: true, warn: true, detail: "unrecognized: modle", fixHint: "check for typos" },
    ]);
    expect(lines[0]).toBe("~ config keys  unrecognized: modle");
    expect(lines[1]).toContain("→ fix: check for typos");
    expect(lines.at(-1)).toBe("1/1 checks passed"); // warning counts as passed
  });

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

describe("optional subsystems", () => {
  /**
   * These five degrade QUIETLY. A configured `sandbox` with no bwrap turns the
   * first run_command into an error; no Playwright means every browser tool is
   * unavailable; no language server means lsp_* fails mid-task; no tree-sitter
   * silently drops the repo map to the regex floor. Doctor reported none of
   * them — it reported the updater — so the first symptom was a run failing
   * partway through.
   */
  it("reports each optional subsystem without failing the report", () => {
    const checks = runDoctor("/proj", healthyConfig, healthyProbes());
    for (const name of ["os sandbox", "browser", "lsp servers", "code parsing", "docker"]) {
      const check = byName(checks, name);
      expect(check, name).toBeDefined();
      expect(check.ok, `${name} must never fail the report`).toBe(true);
    }
  });

  it("warns about a missing sandbox only when the config asks for one", () => {
    const unavailable = { available: false, reason: "bwrap was not found on PATH" };
    // Not configured: informational. The agent works fine unsandboxed if that
    // is what the user chose.
    expect(osSandboxCheck(unavailable, false).warn).toBeUndefined();
    // Configured: run_command will throw sandbox_unavailable on the first
    // command, so saying so now is the whole point.
    const configured = osSandboxCheck(unavailable, true);
    expect(configured.warn).toBe(true);
    expect(configured.detail).toContain("bwrap");
    expect(configured.fixHint).toBeDefined();
    // Available: name the binary that will be used.
    expect(osSandboxCheck({ available: true, binary: "sandbox-exec" }, true).detail).toBe("sandbox-exec");
  });

  it("names the language servers it found, or says the tools are unavailable", () => {
    const withServers = lspServersCheck({ ...healthyProbes(), commandExists: (b) => b === "gopls" });
    expect(withServers.detail).toBe("gopls");
    const none = lspServersCheck({ ...healthyProbes(), commandExists: () => false });
    expect(none.detail).toContain("lsp_* tools unavailable");
    expect(none.fixHint).toBeDefined();
  });

  it("distinguishes the AST backend from the regex floor", () => {
    expect(codeParsingCheck(true).detail).toContain("tree-sitter");
    expect(codeParsingCheck(false).detail).toContain("regex floor");
  });

  it("reports the browser backend by the specifier it would import", () => {
    expect(browserCheck({ available: true, specifier: "playwright-core" }).detail).toBe("playwright-core");
    const missing = browserCheck({ available: false, specifier: "playwright-core" });
    expect(missing.detail).toContain("browser tools unavailable");
    expect(missing.fixHint).toContain("playwright");
  });
});
