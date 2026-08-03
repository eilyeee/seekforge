import { afterEach, describe, expect, it, vi } from "vitest";

// prepareMcp must thread the workspace path to core's loadMcpToolSpecs as the
// roots argument ([workspacePath]) so MCP servers answer roots/list with the
// real workspace, and pass the server-request handlers through in the slot
// after it. We mock core to capture the call rather than spawn servers.
const loadMcpToolSpecs = vi.fn(async () => ({ specs: [], entries: [], dispose: () => {} }));

vi.mock("@seekforge/core", async () => {
  const actual = await vi.importActual<typeof import("@seekforge/core")>("@seekforge/core");
  return { ...actual, loadMcpToolSpecs };
});

const { prepareMcp } = await import("../agent/factory.js");

afterEach(() => loadMcpToolSpecs.mockClear());

describe("prepareMcp workspace roots passthrough", () => {
  const config = { mcpServers: { fake: { command: "node", args: ["x.js"] } } } as never;

  it("forwards the workspace path as the roots argument", async () => {
    await prepareMcp(config, "/abs/workspace");
    expect(loadMcpToolSpecs).toHaveBeenCalledWith(
      { fake: { command: "node", args: ["x.js"] } },
      ["/abs/workspace"],
      undefined,
      undefined,
    );
  });

  it("passes undefined roots when no workspace path is given", async () => {
    await prepareMcp(config);
    expect(loadMcpToolSpecs).toHaveBeenCalledWith(
      { fake: { command: "node", args: ["x.js"] } },
      undefined,
      undefined,
      undefined,
    );
  });

  it("hands the server-request handlers to core", async () => {
    const handlers = { elicitation: async () => ({ action: "decline" as const }) };
    await prepareMcp(config, "/abs/workspace", handlers);
    expect(loadMcpToolSpecs).toHaveBeenCalledWith(
      { fake: { command: "node", args: ["x.js"] } },
      ["/abs/workspace"],
      undefined,
      handlers,
    );
  });

  it("is a no-op (never calls core) when no servers are configured", async () => {
    const out = await prepareMcp({} as never, "/abs/workspace");
    expect(loadMcpToolSpecs).not.toHaveBeenCalled();
    expect(out.specs).toEqual([]);
  });
});
