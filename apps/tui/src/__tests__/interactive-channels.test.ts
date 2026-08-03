import { describe, expect, it } from "vitest";
import { createInteractiveChannelHolder, type InteractiveChannels } from "../agent/interactive-channels.js";

/**
 * The holder exists because the MCP clients are built at startup, before the
 * app can put anything on screen. What matters is that it routes to whoever is
 * currently able to answer — and refuses rather than misroutes when nobody is.
 */
function channels(label: string): InteractiveChannels {
  return {
    confirm: async () => `confirm:${label}` as unknown as boolean,
    askUser: async () => `ask:${label}`,
  };
}

describe("interactive channel holder", () => {
  it("refuses when no run is active, instead of hanging or guessing", async () => {
    const holder = createInteractiveChannelHolder();
    await expect(holder.askUser({ question: "q", options: ["a"] })).rejects.toThrow(/no agent run is active/);
    await expect(holder.confirm({ toolName: "t", permission: "env", description: "d" })).rejects.toThrow(
      /no agent run is active/,
    );
  });

  it("routes to the bound run", async () => {
    const holder = createInteractiveChannelHolder();
    holder.bind(channels("first"));
    expect(await holder.askUser({ question: "q", options: ["a"] })).toBe("ask:first");
  });

  it("keeps routing to the newer run when an older one finishes late", async () => {
    const holder = createInteractiveChannelHolder();
    const first = channels("first");
    const second = channels("second");
    holder.bind(first);
    holder.bind(second);

    // The first run ends after the second started: releasing must not unbind
    // the run that is now on screen.
    holder.release(first);
    expect(await holder.askUser({ question: "q", options: ["a"] })).toBe("ask:second");

    holder.release(second);
    await expect(holder.askUser({ question: "q", options: ["a"] })).rejects.toThrow(/no agent run is active/);
  });
});
