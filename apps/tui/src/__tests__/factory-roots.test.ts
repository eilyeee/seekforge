import { afterEach, describe, expect, it, vi } from "vitest";

// prepareMcp hands every server to core's loadMcpToolSpecs in one call: the
// workspace path as the roots argument (servers answer roots/list with it),
// the server-request handlers, and the options core's connection rule needs —
// the workspace whose approvals apply, each name's origin, and the tool-search
// threshold. Core is mocked to capture the call rather than spawn servers.
const coreRegistry = {
  revision: () => 0,
  entries: () => [],
  toolSpecs: () => [],
  servers: () => [],
  refresh: async () => {},
  reconnect: async () => ({ name: "", state: "disabled" as const, toolCount: 0 }),
  subscribe: () => () => {},
  toolSearchThreshold: 10,
  dispose: () => {},
};
const loadMcpToolSpecs = vi.fn(async () => ({
  specs: [],
  entries: [],
  dispose: () => {},
  registry: coreRegistry,
}));

vi.mock("@seekforge/core", async () => {
  const actual = await vi.importActual<typeof import("@seekforge/core")>("@seekforge/core");
  return { ...actual, loadMcpToolSpecs };
});

const { prepareMcp } = await import("../agent/factory.js");

afterEach(() => loadMcpToolSpecs.mockClear());

describe("prepareMcp", () => {
  const config = { mcpServers: { fake: { command: "node", args: ["x.js"], trusted: true } } } as never;
  const fakeServer = { fake: { command: "node", args: ["x.js"], trusted: true } };

  it("forwards the workspace as roots and as the workspace whose approvals apply", async () => {
    await prepareMcp(config, "/abs/workspace", undefined, { origins: { fake: "user" } });
    expect(loadMcpToolSpecs).toHaveBeenCalledWith(fakeServer, ["/abs/workspace"], undefined, undefined, {
      workspace: "/abs/workspace",
      origins: { fake: "user" },
    });
  });

  it("passes no roots without a workspace path, and treats configured names as the user's", async () => {
    await prepareMcp(config);
    expect(loadMcpToolSpecs).toHaveBeenCalledWith(fakeServer, undefined, undefined, undefined, {
      workspace: process.cwd(),
      origins: { fake: "user" },
    });
  });

  it("hands the server-request handlers and the tool-search threshold to core", async () => {
    const handlers = { elicitation: async () => ({ action: "decline" as const }) };
    await prepareMcp({ ...(config as object), mcpToolSearchThreshold: 30 } as never, "/abs/workspace", handlers, {
      origins: { fake: "user" },
    });
    expect(loadMcpToolSpecs).toHaveBeenCalledWith(fakeServer, ["/abs/workspace"], undefined, handlers, {
      workspace: "/abs/workspace",
      origins: { fake: "user" },
      toolSearchThreshold: 30,
    });
  });

  it("gives core its own copy of each definition", async () => {
    const mcpServers = { fake: { command: "node", trusted: true } };
    const out = await prepareMcp({ mcpServers } as never, "/abs/workspace");
    const passed = (loadMcpToolSpecs.mock.calls[0] as unknown[])[0] as Record<string, object>;
    expect(passed["fake"]).toEqual(mcpServers.fake);
    expect(passed["fake"]).not.toBe(mcpServers.fake);
    expect(out.registry.core).toBe(coreRegistry);
  });

  it("builds the (empty) registry even when no servers are configured", async () => {
    const out = await prepareMcp({} as never, "/abs/workspace");
    expect(loadMcpToolSpecs).toHaveBeenCalledOnce();
    expect(out.registry.statuses()).toEqual([]);
    expect(out.registry.entries()).toEqual([]);
  });
});
