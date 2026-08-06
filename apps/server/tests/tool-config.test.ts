import { describe, expect, it } from "vitest";
import { configureVision, createDefaultDispatcher } from "@seekforge/core";
import { configureServerTools } from "../src/agent.js";
import type { ServerConfig } from "../src/config.js";

/**
 * The config keys that configure BUILTIN tools. They are module-level seams
 * rather than deps (ToolContext carries no credentials), so every entry point
 * that assembles an agent has to apply them — and this one did not:
 * `visionModel` worked in the TUI and the CLI and did nothing in the Desktop,
 * which is served from here.
 *
 * Scoped BY WORKSPACE rather than set process-wide, because unlike a CLI or TUI
 * process this one serves many workspaces and runs them concurrently — its
 * locks serialize per repository, not globally.
 *
 * `browserProfile` is honored here too, now that the browser session itself is
 * keyed by workspace — one Chromium process, one context per workspace.
 */

const base: ServerConfig = { apiKey: "sk-test", model: "deepseek-v4-flash" };

async function analyzeErrorCode(workspace = process.cwd()): Promise<string | undefined> {
  const res = await createDefaultDispatcher().execute(
    { id: "c1", name: "image_analyze", arguments: { path: "shot.png" } },
    {
      sessionId: "s",
      workspace,
      policy: { approvalMode: "auto", mode: "edit", commandAllowlist: [] },
      confirm: async () => true,
    },
  );
  return res.error?.code;
}

describe("configureServerTools", () => {
  it("scopes the browser profile to the workspace that configured it", () => {
    // A profile is a stored login. Before the browser session was keyed by
    // workspace this could not be honored at all here; now the only thing that
    // must hold is that configuring one workspace never speaks for another.
    expect(() => configureServerTools("/ws/a", { ...base, browserProfile: "work" })).not.toThrow();
    expect(() => configureServerTools("/ws/b", base)).not.toThrow();
  });

  it("reports an unusable profile name without failing the run", () => {
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => {
      errors.push(a.join(" "));
    };
    try {
      // A name with a separator is a request to write session cookies outside
      // the profile directory. Refusing the NAME must not refuse the task.
      expect(() => configureServerTools("/ws/a", { ...base, browserProfile: "../escape" })).not.toThrow();
    } finally {
      console.error = realError;
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/browserProfile/);
  });

  it("routes visionModel to image_analyze", async () => {
    configureVision(null);
    configureServerTools(process.cwd(), base);
    expect(await analyzeErrorCode()).toBe("vision_unconfigured");

    configureServerTools(process.cwd(), {
      ...base,
      visionModel: { model: "qwen-vl-plus", baseUrl: "http://127.0.0.1:1/v1" },
    });
    // Configured now: whatever fails next, it is no longer "nobody told me
    // where the vision endpoint is".
    expect(await analyzeErrorCode()).not.toBe("vision_unconfigured");
    configureVision(null);
  });

  it("keeps one workspace's endpoint out of another workspace's run", async () => {
    // THE reason this is scoped. The server's locks serialize per repository,
    // so two workspaces run their agent loops at the same time. A single
    // process-wide endpoint is last-write-wins: workspace A's screenshot would
    // go to workspace B's provider, under B's key.
    configureVision(null);
    configureServerTools("/ws/a", { ...base, visionModel: { model: "m", baseUrl: "http://127.0.0.1:1/v1" } });
    configureServerTools("/ws/b", base); // B has no vision endpoint configured

    expect(await analyzeErrorCode("/ws/a")).not.toBe("vision_unconfigured");
    // B did not inherit A's, and configuring B did not clear A's.
    expect(await analyzeErrorCode("/ws/b")).toBe("vision_unconfigured");
    expect(await analyzeErrorCode("/ws/a")).not.toBe("vision_unconfigured");
    configureVision(null);
  });
});
