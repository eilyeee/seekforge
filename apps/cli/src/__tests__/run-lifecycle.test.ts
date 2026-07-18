import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  loadConfig: () => ({ apiKey: "test-key", model: "deepseek-v4-flash" }),
}));

vi.mock("../authorized-dirs.js", () => ({
  authorizeDir: vi.fn(),
  isAuthorizedDir: () => true,
}));

const { runTaskCommand } = await import("../commands/run.js");

describe("runTaskCommand setup lifecycle", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("does not install a SIGINT listener before permission-mode validation succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const before = process.listeners("SIGINT");

    const completed = await runTaskCommand("task", { mode: "edit", permissionMode: "invalid" });

    expect(completed).toBe(false);
    expect(process.listeners("SIGINT")).toEqual(before);
  });

  it("does not install a SIGINT listener before output-style validation succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const before = process.listeners("SIGINT");

    const completed = await runTaskCommand("task", { mode: "edit", outputStyle: "missing-style" });

    expect(completed).toBe(false);
    expect(process.listeners("SIGINT")).toEqual(before);
  });
});
