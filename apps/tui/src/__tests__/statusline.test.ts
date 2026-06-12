import { describe, expect, it } from "vitest";
import { runStatusLine, type StatusLineInput } from "../statusline.js";

const input: StatusLineInput = { model: "deepseek-chat", cwd: "/tmp", costUsd: 0.12 };

describe("runStatusLine", () => {
  it("returns the trimmed first line of stdout", () => {
    expect(runStatusLine("echo '  hello world  '", input)).toBe("hello world");
    expect(runStatusLine("printf 'first\\nsecond\\n'", input)).toBe("first");
  });

  it("pipes the JSON payload on stdin", () => {
    // Short fields keep the JSON line under the 80-char output cap.
    const full: StatusLineInput = { model: "m", cwd: "/", sessionId: "s1", costUsd: 0.1, contextPercent: 42 };
    const out = runStatusLine("cat", full);
    expect(out).not.toBeNull();
    expect(JSON.parse(out as string)).toEqual(full);
  });

  it("caps output to 80 characters", () => {
    const out = runStatusLine(`echo ${"x".repeat(200)}`, input);
    expect(out).toHaveLength(80);
  });

  it("lets ANSI escapes through", () => {
    const out = runStatusLine("printf '\\033[32mgreen\\033[0m\\n'", input);
    expect(out).toBe("\u001b[32mgreen\u001b[0m");
  });

  it("returns null on empty output, non-zero exit, and bad commands", () => {
    expect(runStatusLine("true", input)).toBeNull();
    expect(runStatusLine("echo ''", input)).toBeNull();
    expect(runStatusLine("exit 1", input)).toBeNull();
    expect(runStatusLine("definitely-not-a-command-xyz", input)).toBeNull();
  });

  it("returns null on timeout", () => {
    expect(runStatusLine("sleep 3; echo late", input, { timeoutMs: 100 })).toBeNull();
  });
});
