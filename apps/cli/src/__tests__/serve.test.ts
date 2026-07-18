import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startServer = vi.hoisted(() => vi.fn());

vi.mock("@seekforge/server", () => ({ startServer }));

const { serveCommand } = await import("../commands/serve.js");

function addedSignalListener(
  signal: "SIGINT" | "SIGTERM",
  before: Set<NodeJS.SignalsListener>,
): NodeJS.SignalsListener {
  const listener = process.listeners(signal).find((candidate) => !before.has(candidate));
  if (!listener) throw new Error(`missing ${signal} listener`);
  return listener;
}

describe("serveCommand lifecycle", () => {
  beforeEach(() => {
    startServer.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes both signal listeners after a graceful shutdown", async () => {
    const beforeInt = new Set(process.listeners("SIGINT"));
    const beforeTerm = new Set(process.listeners("SIGTERM"));
    const close = vi.fn().mockResolvedValue(undefined);
    startServer.mockResolvedValue({ port: 7373, token: "token", close });

    const running = serveCommand({ port: 7373, workspaces: [] });
    await vi.waitFor(() => expect(process.listeners("SIGTERM").length).toBe(beforeTerm.size + 1));
    addedSignalListener("SIGTERM", beforeTerm)("SIGTERM");
    await running;

    expect(close).toHaveBeenCalledOnce();
    expect(new Set(process.listeners("SIGINT"))).toEqual(beforeInt);
    expect(new Set(process.listeners("SIGTERM"))).toEqual(beforeTerm);
  });

  it("rejects and still removes listeners when server close fails", async () => {
    const beforeInt = new Set(process.listeners("SIGINT"));
    const beforeTerm = new Set(process.listeners("SIGTERM"));
    const close = vi.fn().mockRejectedValue(new Error("close failed"));
    startServer.mockResolvedValue({ port: 7373, token: "token", close });

    const running = serveCommand({ port: 7373, workspaces: [] });
    await vi.waitFor(() => expect(process.listeners("SIGTERM").length).toBe(beforeTerm.size + 1));
    addedSignalListener("SIGTERM", beforeTerm)("SIGTERM");
    await expect(running).rejects.toThrow("close failed");

    expect(new Set(process.listeners("SIGINT"))).toEqual(beforeInt);
    expect(new Set(process.listeners("SIGTERM"))).toEqual(beforeTerm);
  });
});
