import { describe, expect, it } from "vitest";
import { runStatusLine, type StatusLineInput } from "../statusline.js";

const input: StatusLineInput = { model: "deepseek-chat", cwd: "/tmp", costUsd: 0.12 };

describe("runStatusLine", () => {
  it("returns the trimmed first line of stdout", async () => {
    expect(await runStatusLine("echo '  hello world  '", input)).toBe("hello world");
    expect(await runStatusLine("printf 'first\\nsecond\\n'", input)).toBe("first");
  });

  it("pipes the JSON payload on stdin", async () => {
    // Short fields keep the JSON line under the 80-char output cap.
    const full: StatusLineInput = { model: "m", cwd: "/", sessionId: "s1", costUsd: 0.1, contextPercent: 42 };
    const out = await runStatusLine("cat", full);
    expect(out).not.toBeNull();
    expect(JSON.parse(out as string)).toEqual(full);
  });

  it("caps output to 80 characters", async () => {
    const out = await runStatusLine(`echo ${"x".repeat(200)}`, input);
    expect(out).toHaveLength(80);
  });

  it("lets ANSI escapes through", async () => {
    const out = await runStatusLine("printf '\\033[32mgreen\\033[0m\\n'", input);
    expect(out).toBe("\u001b[32mgreen\u001b[0m");
  });

  it("returns null on empty output, non-zero exit, and bad commands", async () => {
    expect(await runStatusLine("true", input)).toBeNull();
    expect(await runStatusLine("echo ''", input)).toBeNull();
    expect(await runStatusLine("exit 1", input)).toBeNull();
    expect(await runStatusLine("definitely-not-a-command-xyz", input)).toBeNull();
  });

  it("returns null on timeout", async () => {
    expect(await runStatusLine("sleep 3; echo late", input, { timeoutMs: 100 })).toBeNull();
  });

  it("exposes context as SEEKFORGE_* env vars", async () => {
    const full: StatusLineInput = {
      model: "m",
      cwd: "/",
      sessionId: "s1",
      costUsd: 0.1,
      contextPercent: 42,
      approval: "auto",
      totalTokens: 1234,
    };
    expect(await runStatusLine('printf "%s" "$SEEKFORGE_MODEL"', full)).toBe("m");
    expect(await runStatusLine('printf "%s" "$SEEKFORGE_APPROVAL"', full)).toBe("auto");
    expect(await runStatusLine('printf "%s" "$SEEKFORGE_TOTAL_TOKENS"', full)).toBe("1234");
    expect(await runStatusLine('printf "%s" "$SEEKFORGE_CONTEXT_PERCENT"', full)).toBe("42");
  });

  it("does not expose provider credentials or unrelated host environment", async () => {
    const previous = process.env["DEEPSEEK_API_KEY"];
    process.env["DEEPSEEK_API_KEY"] = "must-not-leak";
    try {
      expect(await runStatusLine('printf "%s" "$DEEPSEEK_API_KEY"', input)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env["DEEPSEEK_API_KEY"];
      else process.env["DEEPSEEK_API_KEY"] = previous;
    }
  });

  it("runs with the workspace as cwd", async () => {
    // /tmp is symlinked to /private/tmp on macOS, so resolve via the shell's pwd -P.
    expect(await runStatusLine("pwd", { model: "m", cwd: process.cwd(), costUsd: 0 })).toBe(process.cwd());
  });

  it("returns without waiting for descendants that inherit stdout", async () => {
    const started = Date.now();
    expect(await runStatusLine("sleep 10 &", input, { timeoutMs: 50 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
