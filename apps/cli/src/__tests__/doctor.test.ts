// Tests for the `seekforge doctor` provider/api-key diagnostics.

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  configKeysCheck,
  configParseCheck,
  runDoctor,
  type DoctorCheck,
  type DoctorProbes,
} from "../commands/doctor.js";

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

test("configKeysCheck passes when there are no unknown keys", () => {
  const check = configKeysCheck([]);
  assert.equal(check.ok, true);
  assert.equal(check.warn, undefined);
  assert.equal(check.detail, "all recognized");
});

test("configKeysCheck warns (non-fatal) and lists unrecognized keys", () => {
  const check = configKeysCheck(["modle", "reasoningEffrt"]);
  assert.equal(check.ok, true); // warning, not a failure — must not flip exit code
  assert.equal(check.warn, true);
  assert.ok(check.detail.includes("modle") && check.detail.includes("reasoningEffrt"));
  assert.ok(check.fixHint);
});

test("an unrecognized provider value warns and notes the DeepSeek fallback", () => {
  const check = byName(runDoctor("/proj", { provider: "arkk" }, healthyProbes()), "provider");
  assert.equal(check.ok, true); // warning, not a failure
  assert.equal(check.warn, true);
  assert.ok(check.detail.includes("arkk"));
  assert.ok(check.detail.toLowerCase().includes("deepseek"));
});

test("an unrecognized provider with an explicit baseUrl is not a warning", () => {
  const config = { provider: "arkk", baseUrl: "https://custom.example.com" };
  const check = byName(runDoctor("/proj", config, healthyProbes()), "provider");
  assert.equal(check.warn, undefined);
  assert.equal(check.detail, "arkk (https://custom.example.com)");
});

test("configParseCheck passes when there are no parse errors", () => {
  const check = configParseCheck([]);
  assert.equal(check.ok, true);
  assert.equal(check.warn, undefined);
});

test("configParseCheck fails and lists the unparseable files", () => {
  const check = configParseCheck(["/proj/.seekforge/config.json"]);
  assert.equal(check.ok, false); // a failure — must flip the exit code
  assert.ok(check.detail.includes("/proj/.seekforge/config.json"));
  assert.ok(check.fixHint);
});

test("doctor warns instead of crashing when tauri config is null", () => {
  const probes = healthyProbes({
    findRepoRoot: () => "/repo",
    readText: (path) => path.endsWith("tauri.conf.json") ? "null" : null,
  });
  const check = byName(runDoctor("/proj", { apiKey: "sk" }, probes), "updater");
  assert.equal(check.warn, true);
  assert.ok(check.detail.includes("must contain an object"));
});
