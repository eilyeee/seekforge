// The config keys that configure BUILTIN tools — image_analyze's endpoint and
// the persistent browser session. They are module-level seams rather than deps
// (ToolContext carries no credentials and no user paths), which is exactly how
// they came to work in the TUI and do nothing in `seekforge run`: one entry
// point called configure*, the other never did.

import assert from "node:assert/strict";
import { test } from "vitest";
import { createDefaultDispatcher, configureVision } from "@seekforge/core";
import { configureCliTools } from "../agent-factory.js";
import { KNOWN_CONFIG_KEYS } from "../config.js";
import type { CliConfig } from "../config.js";

const base: CliConfig = { apiKey: "sk-test", model: "deepseek-v4-flash" };

async function analyzeErrorCode(): Promise<string | undefined> {
  const res = await createDefaultDispatcher().execute(
    { id: "c1", name: "image_analyze", arguments: { path: "shot.png" } },
    {
      sessionId: "s",
      workspace: process.cwd(),
      policy: { approvalMode: "auto", mode: "edit", commandAllowlist: [] },
      confirm: async () => true,
    },
  );
  return res.error?.code;
}

test("the CLI recognizes the tool-config keys instead of calling them typos", () => {
  // `seekforge doctor` flagged these as unknown while the TUI honored them —
  // the same config file, warned about by one command and used by the other.
  assert.ok(KNOWN_CONFIG_KEYS.has("visionModel"));
  assert.ok(KNOWN_CONFIG_KEYS.has("browserProfile"));
});

test("visionModel reaches image_analyze from CLI config", async () => {
  configureVision(null);
  configureCliTools(base);
  assert.equal(await analyzeErrorCode(), "vision_unconfigured");

  configureCliTools({ ...base, visionModel: { model: "qwen-vl-plus", baseUrl: "http://127.0.0.1:1/v1" } });
  // Configured now: whatever goes wrong next, it is no longer "nobody told me
  // where the vision endpoint is".
  assert.notEqual(await analyzeErrorCode(), "vision_unconfigured");
  configureVision(null);
});

test("an unusable browserProfile warns and leaves the run alone", () => {
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => {
    errors.push(a.join(" "));
  };
  try {
    // A name with a separator is a request to write session cookies somewhere
    // other than the profile directory. Refusing the NAME must not refuse the
    // task — the profile is a convenience, not the point of the run.
    assert.doesNotThrow(() => configureCliTools({ ...base, browserProfile: "../escape" }));
  } finally {
    console.error = realError;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /browserProfile/);
});
