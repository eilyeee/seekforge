// Tests for the `seekforge doctor` provider/api-key diagnostics. Uses the same
// tsx runner + node:assert pattern as config.test.ts.

import assert from "node:assert/strict";
import { runDoctor, type DoctorCheck, type DoctorProbes } from "../commands/doctor.js";

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  }
}

/** Probes for a healthy darwin env, not inside the monorepo (desktop checks skip). */
function healthyProbes(over: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    env: (key) => (key === "EDITOR" ? "vim" : undefined),
    fileExists: () => true,
    nodeVersion: () => "v22.4.0",
    platform: () => "darwin",
    commandExists: (bin) => bin === "pbcopy",
    countDir: () => 3,
    which: () => "/usr/local/bin/seekforge",
    findRepoRoot: () => null,
    glob: () => null,
    readText: () => null,
    ...over,
  };
}

function byName(checks: DoctorCheck[], name: string): DoctorCheck {
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`no check named "${name}"`);
  return found;
}

test("defaults to the deepseek provider with its base URL", () => {
  const check = byName(runDoctor("/proj", { apiKey: "sk" }, healthyProbes()), "provider");
  assert.equal(check.ok, true);
  assert.equal(check.detail, "deepseek (https://api.deepseek.com)");
});

test("deepseek api key check passes when apiKey is configured", () => {
  const check = byName(runDoctor("/proj", { apiKey: "sk" }, healthyProbes()), "api key");
  assert.equal(check.ok, true);
  assert.equal(check.detail, "configured");
});

test("deepseek api key check fails and points at DEEPSEEK_API_KEY", () => {
  const check = byName(runDoctor("/proj", {}, healthyProbes()), "api key");
  assert.equal(check.ok, false);
  assert.ok(check.fixHint?.includes("DEEPSEEK_API_KEY"));
});

test("reports the ark provider and base URL", () => {
  const check = byName(runDoctor("/proj", { provider: "ark" }, healthyProbes()), "provider");
  assert.equal(check.ok, true);
  assert.ok(check.detail.includes("ark"));
  assert.ok(check.detail.includes("ark.cn-beijing.volces.com"));
});

test("ark api key check passes when ARK_API_KEY is set in the env", () => {
  const probes = healthyProbes({ env: (key) => (key === "ARK_API_KEY" ? "sk-ark" : undefined) });
  const check = byName(runDoctor("/proj", { provider: "ark" }, probes), "api key");
  assert.equal(check.ok, true);
  assert.equal(check.detail, "configured");
});

test("ark api key check fails and points at ARK_API_KEY when unset", () => {
  const check = byName(runDoctor("/proj", { provider: "ark" }, healthyProbes()), "api key");
  assert.equal(check.ok, false);
  assert.ok(check.fixHint?.includes("ARK_API_KEY"));
});

test("an explicit baseUrl override wins in the provider line", () => {
  const config = { provider: "ark", baseUrl: "https://custom.example.com", apiKey: "sk" };
  const check = byName(runDoctor("/proj", config, healthyProbes()), "provider");
  assert.equal(check.detail, "ark (https://custom.example.com)");
});

console.log(`${passed} doctor tests passed`);
