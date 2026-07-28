import { describe, expect, it } from "vitest";
import { createGitHubCiProvider, createGitLabCiProvider, type CiCommandResult } from "../ci-provider.js";

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

describe("GitLab Loop CI provider", () => {
  const signal = new AbortController().signal;

  it("waits for a branch pipeline and retrieves a bounded failed job trace", async () => {
    const calls: string[][] = [];
    const provider = createGitLabCiProvider(async (args) => {
      calls.push(args);
      if (args[1] === "status") return { status: 0, stdout: "passed", stderr: "" };
      if (args[1] === "get") {
        return {
          status: 0,
          stdout: JSON.stringify({ pipeline: { jobs: [{ id: 42, status: "failed" }] } }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "trace", stderr: "" };
    });
    await expect(provider.waitForRequiredChecks("main", signal)).resolves.toMatchObject({ status: "passed" });
    await expect(provider.failedLog("main", signal)).resolves.toBe("trace");
    expect(calls).toContainEqual(["ci", "trace", "42", "--branch", "main"]);
  });

  it("preserves cancellation as control flow", async () => {
    const cancelled = Object.assign(new Error("cancelled"), { code: "ABORT_ERR" });
    const provider = createGitLabCiProvider(async () => ({ status: null, stdout: "", stderr: "", error: cancelled }));
    await expect(provider.waitForRequiredChecks("main", signal)).rejects.toBe(cancelled);
  });
});
