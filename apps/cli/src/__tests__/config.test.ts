// Tests for loadConfig settings-file layering. Uses the same pattern as
// helpers.test.ts: tsx runner, node:assert, first failure exits non-zero.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config.js";

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

console.log(`${passed} config tests passed`);
