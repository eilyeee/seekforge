// Tests for loadConfig settings-file layering. Uses the same pattern as
// helpers.test.ts: tsx runner, node:assert, first failure exits non-zero.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configParseErrors, loadConfig, unknownConfigKeys } from "../config.js";
import { configSetCommand } from "../commands/config.js";

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

/**
 * Create a temporary project directory with an optional .seekforge/config.json.
 * Returns the project path. The caller must remove it via cleanup().
 */
function setupProject(projectConfig: Record<string, unknown> = {}): {
  projectPath: string;
  cleanup: () => void;
} {
  const projectPath = mkdtempSync(join(tmpdir(), "sf-config-test-"));
  if (Object.keys(projectConfig).length > 0) {
    const seekDir = join(projectPath, ".seekforge");
    mkdirSync(seekDir, { recursive: true });
    writeFileSync(join(seekDir, "config.json"), JSON.stringify(projectConfig));
  }
  return { projectPath, cleanup: () => rmSync(projectPath, { recursive: true }) };
}

/** Write a settings file in the project dir and return its absolute path. */
function writeSettings(
  projectPath: string,
  name: string,
  content: Record<string, unknown>,
): string {
  const abs = join(projectPath, name);
  writeFileSync(abs, JSON.stringify(content));
  return abs;
}

// ── Scalar overrides ─────────────────────────────────────────────────────────

test("settings file overrides project scalar values", () => {
  const { projectPath, cleanup } = setupProject({ model: "deepseek-chat", baseUrl: "http://old" });
  const settingsPath = writeSettings(projectPath, "settings.json", {
    model: "deepseek-v4-flash",
    thinking: true,
  });

  const config = loadConfig(projectPath, settingsPath);
  assert.equal(config.model, "deepseek-v4-flash");
  assert.equal(config.thinking, true);
  // baseUrl from project should still be present since settings didn't touch it
  assert.equal(config.baseUrl, "http://old");
  cleanup();
});

test("without settings file, project values remain unchanged", () => {
  const { projectPath, cleanup } = setupProject({ model: "deepseek-chat" });
  const config = loadConfig(projectPath);
  assert.equal(config.model, "deepseek-chat");
  cleanup();
});

// ── mcpServers deep-merge ────────────────────────────────────────────────────

test("settings mcpServers merge per-server (adds new, keeps project servers)", () => {
  const { projectPath, cleanup } = setupProject({
    mcpServers: {
      fs: { command: "npx", args: ["-y", "fs-server"] },
    },
  });
  const settingsPath = writeSettings(projectPath, "settings.json", {
    mcpServers: {
      stats: { command: "npx", args: ["-y", "stats-server"] },
    },
  });
  const config = loadConfig(projectPath, settingsPath);
  assert.ok(config.mcpServers);
  // original project server kept
  assert.deepEqual(config.mcpServers["fs"], { command: "npx", args: ["-y", "fs-server"] });
  // new server from settings added
  assert.deepEqual(config.mcpServers["stats"], { command: "npx", args: ["-y", "stats-server"] });
  cleanup();
});

test("settings mcpServers win over project for same server name", () => {
  const { projectPath, cleanup } = setupProject({
    mcpServers: {
      fs: { command: "npx", args: ["-y", "old-fs"] },
    },
  });
  const settingsPath = writeSettings(projectPath, "settings.json", {
    mcpServers: {
      fs: { command: "npx", args: ["-y", "new-fs"] },
    },
  });
  const config = loadConfig(projectPath, settingsPath);
  assert.ok(config.mcpServers);
  assert.deepEqual(config.mcpServers["fs"], { command: "npx", args: ["-y", "new-fs"] });
  cleanup();
});

// ── permissionRules layering ─────────────────────────────────────────────────

test("settings permissionRules are prepended (higher priority than project)", () => {
  const { projectPath, cleanup } = setupProject({
    permissionRules: [{ action: "deny", tool: "run_command" }],
  });
  const settingsPath = writeSettings(projectPath, "settings.json", {
    permissionRules: [{ action: "allow", tool: "run_command" }],
  });
  const config = loadConfig(projectPath, settingsPath);
  assert.ok(config.permissionRules);
  // settings rule comes first (first-match wins, so allow wins over deny)
  assert.deepEqual(config.permissionRules, [
    { action: "allow", tool: "run_command" },
    { action: "deny", tool: "run_command" },
  ]);
  cleanup();
});

// ── hooks layering ───────────────────────────────────────────────────────────

test("settings hooks are appended after project hooks", () => {
  const { projectPath, cleanup } = setupProject({
    hooks: {
      preToolUse: [{ command: "echo project-hook" }],
    },
  });
  const settingsPath = writeSettings(projectPath, "settings.json", {
    hooks: {
      preToolUse: [{ command: "echo settings-hook" }],
    },
  });
  const config = loadConfig(projectPath, settingsPath);
  assert.ok(config.hooks);
  assert.ok(config.hooks.preToolUse);
  assert.equal(config.hooks.preToolUse.length, 2);
  assert.deepEqual(config.hooks.preToolUse[0], { command: "echo project-hook" });
  assert.deepEqual(config.hooks.preToolUse[1], { command: "echo settings-hook" });
  cleanup();
});

test("non-default-stage hooks (sessionStart) survive alongside preToolUse in the same layer", () => {
  // Regression: loadConfig previously merged only 3 stages, so a sessionStart
  // (or userPromptSubmit) hook was dropped whenever a preToolUse hook existed
  // in any layer. Security-relevant: userPromptSubmit can block/inject context.
  const { projectPath, cleanup } = setupProject({
    hooks: {
      preToolUse: [{ command: "echo pre" }],
      sessionStart: [{ command: "echo session-start" }],
      userPromptSubmit: [{ command: "echo prompt-submit" }],
    },
  });
  const config = loadConfig(projectPath);
  assert.ok(config.hooks);
  // The preToolUse hook is preserved...
  assert.deepEqual(config.hooks.preToolUse, [{ command: "echo pre" }]);
  // ...and so is sessionStart (would be dropped under the old 3-stage list).
  assert.deepEqual(config.hooks.sessionStart, [{ command: "echo session-start" }]);
  assert.deepEqual(config.hooks.userPromptSubmit, [{ command: "echo prompt-submit" }]);
  cleanup();
});

// ── Error handling ───────────────────────────────────────────────────────────

test("missing settings file throws a descriptive error", () => {
  const { projectPath, cleanup } = setupProject();
  assert.throws(
    () => loadConfig(projectPath, join(projectPath, "nope.json")),
    (err: unknown) => {
      const e = err as Error & { hint?: string };
      return (
        typeof e.message === "string" &&
        e.message.includes("settings file not found") &&
        e.hint === "check the path and try again"
      );
    },
  );
  cleanup();
});

test("invalid JSON in settings file throws a descriptive error", () => {
  const { projectPath, cleanup } = setupProject();
  const badPath = join(projectPath, "bad.json");
  writeFileSync(badPath, "{ invalid json }", "utf8");
  assert.throws(
    () => loadConfig(projectPath, badPath),
    (err: unknown) => {
      const e = err as Error & { hint?: string };
      return (
        typeof e.message === "string" &&
        e.message.includes("invalid JSON") &&
        e.hint === "ensure the file contains valid JSON"
      );
    },
  );
  cleanup();
});

test("configSetCommand rejects non-object config JSON without overwriting it", () => {
  const { projectPath, cleanup } = setupProject();
  const seekDir = join(projectPath, ".seekforge");
  mkdirSync(seekDir, { recursive: true });
  const configPath = join(seekDir, "config.json");
  writeFileSync(configPath, "null\n", "utf8");
  const oldCwd = process.cwd();
  const oldExitCode = process.exitCode;
  const oldError = console.error;
  const oldLog = console.log;
  const errors: string[] = [];
  try {
    process.chdir(projectPath);
    process.exitCode = undefined;
    console.error = (msg?: unknown) => {
      errors.push(String(msg));
    };
    console.log = () => {};
    configSetCommand("model", "deepseek-chat", {});
    assert.equal(process.exitCode, 1);
    assert.match(errors.join("\n"), /invalid JSON/);
    assert.equal(readFileSync(configPath, "utf8"), "null\n");
  } finally {
    process.chdir(oldCwd);
    process.exitCode = oldExitCode;
    console.error = oldError;
    console.log = oldLog;
    cleanup();
  }
});

test("configSetCommand refuses a symlinked project config", () => {
  const { projectPath, cleanup } = setupProject();
  const externalDir = mkdtempSync(join(tmpdir(), "sf-config-external-"));
  const external = join(externalDir, "config.json");
  const seekDir = join(projectPath, ".seekforge");
  mkdirSync(seekDir);
  writeFileSync(external, '{"model":"keep"}\n');
  symlinkSync(external, join(seekDir, "config.json"));
  const oldCwd = process.cwd();
  const oldExitCode = process.exitCode;
  const oldError = console.error;
  try {
    process.chdir(projectPath);
    process.exitCode = undefined;
    console.error = () => {};
    configSetCommand("model", "overwrite", {});
    assert.equal(process.exitCode, 1);
    assert.equal(readFileSync(external, "utf8"), '{"model":"keep"}\n');
  } finally {
    process.chdir(oldCwd);
    process.exitCode = oldExitCode;
    console.error = oldError;
    cleanup();
    rmSync(externalDir, { recursive: true, force: true });
  }
});

test("configSetCommand refuses a symlinked project state directory", () => {
  const { projectPath, cleanup } = setupProject();
  const externalDir = mkdtempSync(join(tmpdir(), "sf-config-external-"));
  symlinkSync(externalDir, join(projectPath, ".seekforge"));
  const oldCwd = process.cwd();
  const oldExitCode = process.exitCode;
  const oldError = console.error;
  try {
    process.chdir(projectPath);
    process.exitCode = undefined;
    console.error = () => {};
    configSetCommand("model", "overwrite", {});
    assert.equal(process.exitCode, 1);
    assert.equal(existsSync(join(externalDir, "config.json")), false, "external file must not be created");
  } finally {
    process.chdir(oldCwd);
    process.exitCode = oldExitCode;
    console.error = oldError;
    cleanup();
    rmSync(externalDir, { recursive: true, force: true });
  }
});

// ── config.local.json personal layer ─────────────────────────────────────────

/** Write .seekforge/config.local.json in the project dir. */
function writeLocal(projectPath: string, content: Record<string, unknown>): void {
  const seekDir = join(projectPath, ".seekforge");
  mkdirSync(seekDir, { recursive: true });
  writeFileSync(join(seekDir, "config.local.json"), JSON.stringify(content));
}

test("config.local.json overrides project scalars but loses to --settings", () => {
  const { projectPath, cleanup } = setupProject({ model: "deepseek-chat", baseUrl: "http://proj" });
  writeLocal(projectPath, { model: "deepseek-v4-flash", baseUrl: "http://local" });
  // No settings file: local wins over project.
  let config = loadConfig(projectPath);
  assert.equal(config.model, "deepseek-v4-flash");
  assert.equal(config.baseUrl, "http://local");
  // With a settings file: settings wins over local for the keys it sets.
  const settingsPath = writeSettings(projectPath, "settings.json", { model: "deepseek-v4-pro" });
  config = loadConfig(projectPath, settingsPath);
  assert.equal(config.model, "deepseek-v4-pro");
  assert.equal(config.baseUrl, "http://local"); // untouched by settings
  cleanup();
});

test("config.local.json mcpServers merge above project", () => {
  const { projectPath, cleanup } = setupProject({
    mcpServers: { fs: { command: "npx", args: ["old"] } },
  });
  writeLocal(projectPath, { mcpServers: { fs: { command: "npx", args: ["local"] } } });
  const config = loadConfig(projectPath);
  assert.deepEqual(config.mcpServers?.["fs"], { command: "npx", args: ["local"] });
  cleanup();
});

// ── profiles ─────────────────────────────────────────────────────────────────

test("a selected profile overrides base scalar values", () => {
  const { projectPath, cleanup } = setupProject({
    model: "deepseek-chat",
    baseUrl: "http://base",
    profiles: {
      fast: { model: "deepseek-v4-flash", thinking: true },
    },
  });
  // Without selecting the profile, base values stand and `profiles` is stripped.
  const base = loadConfig(projectPath);
  assert.equal(base.model, "deepseek-chat");
  assert.equal(base.profiles, undefined);
  // Selecting the profile overlays its fields on the merged base.
  const config = loadConfig(projectPath, undefined, "fast");
  assert.equal(config.model, "deepseek-v4-flash");
  assert.equal(config.thinking, true);
  // untouched base scalar survives
  assert.equal(config.baseUrl, "http://base");
  // `profiles` itself never leaks into the returned config
  assert.equal(config.profiles, undefined);
  cleanup();
});

test("profile mcpServers deep-merge with the base (adds new, keeps base servers)", () => {
  const { projectPath, cleanup } = setupProject({
    mcpServers: { fs: { command: "npx", args: ["-y", "fs-server"] } },
    profiles: {
      research: {
        mcpServers: { stats: { command: "npx", args: ["-y", "stats-server"] } },
      },
    },
  });
  const config = loadConfig(projectPath, undefined, "research");
  assert.ok(config.mcpServers);
  // base server preserved
  assert.deepEqual(config.mcpServers["fs"], { command: "npx", args: ["-y", "fs-server"] });
  // profile server added
  assert.deepEqual(config.mcpServers["stats"], { command: "npx", args: ["-y", "stats-server"] });
  cleanup();
});

test("profile mcpServers win over base for the same server name", () => {
  const { projectPath, cleanup } = setupProject({
    mcpServers: { fs: { command: "npx", args: ["-y", "old-fs"] } },
    profiles: {
      research: { mcpServers: { fs: { command: "npx", args: ["-y", "new-fs"] } } },
    },
  });
  const config = loadConfig(projectPath, undefined, "research");
  assert.deepEqual(config.mcpServers?.["fs"], { command: "npx", args: ["-y", "new-fs"] });
  cleanup();
});

test("unknown profile throws an error listing available profile names", () => {
  const { projectPath, cleanup } = setupProject({
    profiles: { fast: { model: "deepseek-v4-flash" }, slow: { model: "deepseek-v4-pro" } },
  });
  assert.throws(
    () => loadConfig(projectPath, undefined, "nope"),
    (err: unknown) => {
      const e = err as Error & { hint?: string };
      return (
        typeof e.message === "string" &&
        e.message.includes('unknown profile "nope"') &&
        typeof e.hint === "string" &&
        e.hint.includes("fast") &&
        e.hint.includes("slow")
      );
    },
  );
  cleanup();
});

test("SEEKFORGE_PROFILE env selects a profile when no explicit arg is given", () => {
  const { projectPath, cleanup } = setupProject({
    model: "deepseek-chat",
    profiles: { fast: { model: "deepseek-v4-flash" } },
  });
  const prev = process.env["SEEKFORGE_PROFILE"];
  process.env["SEEKFORGE_PROFILE"] = "fast";
  try {
    const config = loadConfig(projectPath);
    assert.equal(config.model, "deepseek-v4-flash");
    // explicit arg overrides the env selection
    const { projectPath: p2, cleanup: c2 } = setupProject({
      model: "deepseek-chat",
      profiles: { fast: { model: "deepseek-v4-flash" }, slow: { model: "deepseek-v4-pro" } },
    });
    const config2 = loadConfig(p2, undefined, "slow");
    assert.equal(config2.model, "deepseek-v4-pro");
    c2();
  } finally {
    if (prev === undefined) delete process.env["SEEKFORGE_PROFILE"];
    else process.env["SEEKFORGE_PROFILE"] = prev;
  }
  cleanup();
});

test("profile slots below --settings: settings wins for keys it sets", () => {
  const { projectPath, cleanup } = setupProject({
    model: "deepseek-chat",
    baseUrl: "http://base",
    profiles: { fast: { model: "deepseek-v4-flash", baseUrl: "http://profile" } },
  });
  const settingsPath = writeSettings(projectPath, "settings.json", { model: "deepseek-v4-pro" });
  const config = loadConfig(projectPath, settingsPath, "fast");
  // settings overrides the profile's model
  assert.equal(config.model, "deepseek-v4-pro");
  // profile's baseUrl stands since settings didn't touch it
  assert.equal(config.baseUrl, "http://profile");
  cleanup();
});

test("unknownConfigKeys flags a top-level typo but not recognized keys", () => {
  const { projectPath, cleanup } = setupProject({ model: "deepseek-v4-flash", modle: "typo", provider: "ark" });
  const unknown = unknownConfigKeys(projectPath);
  assert.ok(unknown.includes("modle"), "typo key should be reported");
  assert.ok(!unknown.includes("model"), "recognized key must not be reported");
  assert.ok(!unknown.includes("provider"), "recognized key must not be reported");
  cleanup();
});

test("unknownConfigKeys flags a typo inside a named profile", () => {
  const { projectPath, cleanup } = setupProject({
    model: "deepseek-v4-flash",
    profiles: { fast: { model: "deepseek-v4-pro", reasoningEffrt: "high" } },
  });
  const unknown = unknownConfigKeys(projectPath);
  assert.ok(unknown.includes("reasoningEffrt"), "profile-nested typo should be reported");
  assert.ok(!unknown.includes("profiles"), "profiles itself is a recognized key");
  cleanup();
});

// ── provider-aware env API-key precedence ────────────────────────────────────

/** Run `fn` with the given env keys set, restoring prior values afterward. */
function withEnv(keys: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(keys)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(keys)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("default (DeepSeek) config with both env keys set uses DEEPSEEK_API_KEY", () => {
  const { projectPath, cleanup } = setupProject({ apiKey: "from-file" });
  withEnv({ ARK_API_KEY: "sk-ark", DEEPSEEK_API_KEY: "sk-deepseek" }, () => {
    // No provider => default deepseek: an exported ARK_API_KEY must not leak.
    assert.equal(loadConfig(projectPath).apiKey, "sk-deepseek");
  });
  cleanup();
});

test("ark config with both env keys set uses ARK_API_KEY", () => {
  const { projectPath, cleanup } = setupProject({ provider: "ark", apiKey: "from-file" });
  withEnv({ ARK_API_KEY: "sk-ark", DEEPSEEK_API_KEY: "sk-deepseek" }, () => {
    assert.equal(loadConfig(projectPath).apiKey, "sk-ark");
  });
  cleanup();
});

// ── configParseErrors ────────────────────────────────────────────────────────

test("configParseErrors is empty when configs are valid or absent", () => {
  const { projectPath, cleanup } = setupProject({ model: "deepseek-chat" });
  assert.deepEqual(configParseErrors(projectPath), []);
  cleanup();
});

test("configParseErrors reports a syntactically broken project config", () => {
  const { projectPath, cleanup } = setupProject();
  const seekDir = join(projectPath, ".seekforge");
  mkdirSync(seekDir, { recursive: true });
  const broken = join(seekDir, "config.json");
  writeFileSync(broken, "{ not valid json ");
  const errors = configParseErrors(projectPath);
  assert.ok(errors.includes(broken), "broken config path should be reported");
  cleanup();
});

console.log(`${passed} config tests passed`);
