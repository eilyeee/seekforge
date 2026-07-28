import { describe, expect, it } from "vitest";
import { createGitHubCiProvider, type CiCommandResult } from "../ci-provider.js";

describe("GitHub Loop CI provider", () => {
  const signal = new AbortController().signal;

  it("normalizes passed, absent, failed, and timeout check states", async () => {
    const outcomes: CiCommandResult[] = [
      { status: 0, stdout: "ok", stderr: "" },
      { status: 1, stdout: "no checks reported on this branch", stderr: "" },
      { status: 1, stdout: "unit failed", stderr: "" },
      { status: null, stdout: "", stderr: "", error: Object.assign(new Error("late"), { code: "ETIMEDOUT" }) },
    ];
    const provider = createGitHubCiProvider(async () => outcomes.shift()!);
    await expect(provider.waitForRequiredChecks("pr", signal)).resolves.toMatchObject({ status: "passed" });
    await expect(provider.waitForRequiredChecks("pr", signal)).resolves.toMatchObject({ status: "passed" });
    await expect(provider.waitForRequiredChecks("pr", signal)).resolves.toMatchObject({ status: "failed" });
    await expect(provider.waitForRequiredChecks("pr", signal)).resolves.toMatchObject({ status: "timed_out" });
  });

  it("returns a bounded failed run log", async () => {
    const provider = createGitHubCiProvider(async (args) =>
      args.includes("list")
        ? { status: 0, stdout: JSON.stringify([{ databaseId: 42 }]), stderr: "" }
        : { status: 0, stdout: "failure details", stderr: "" },
    );
    await expect(provider.failedLog("seekforge/test", signal)).resolves.toBe("failure details");
  });
});
