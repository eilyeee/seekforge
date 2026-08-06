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
 * `browserProfile` is deliberately absent from ServerConfig: the browser
 * session is one Chromium per process, so a per-workspace cookie file cannot be
 * honored by a shared context. See the note in apps/server/src/agent.ts.
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
