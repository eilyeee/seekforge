import { describe, expect, it } from "vitest";
import type { ConfirmResult, PermissionRequest } from "@seekforge/shared";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

/**
 * Security regression suite for the auto-approval ("-y" /
 * --dangerously-skip-permissions) tier. `approvalMode: "auto"` is the
 * full-bypass mode: normal writes and command execution run without a prompt.
 * But two invariants must hold EVEN in auto mode, or the bypass becomes a
 * footgun a refactor could silently widen:
 *
 *   1. A denylisted / `dangerous` command is STILL refused outright — never
 *      run, never even prompted (an allow rule / session allowlist can't
 *      rescue it either).
 *   2. An env-changing action (package install, web fetch/search, untrusted
 *      MCP call) STILL requires explicit confirmation.
 *
 * These lock the contract in permissions.ts. Fully deterministic: no model,
 * no network (commands are classified, but only safe ones are actually run).
 */

const dispatcher = createDefaultDispatcher();

function scriptedConfirm(answer: ConfirmResult): {
  confirm: (req: PermissionRequest) => Promise<ConfirmResult>;
  requests: PermissionRequest[];
} {
  const requests: PermissionRequest[] = [];
  return {
    requests,
    confirm: async (req) => {
      requests.push(req);
      return answer;
    },
  };
}

describe("auto mode: normal write/execute are auto-approved", () => {
  it("auto-approves an in-workspace write without prompting", async () => {
    const ws = makeWorkspace();
    const { confirm, requests } = scriptedConfirm(false);
    const ctx = makeCtx(ws, { policy: { approvalMode: "auto" }, confirm });
    const res = await dispatcher.execute(call("write_file", { path: "a.txt", content: "x" }), ctx);
    expect(res.ok).toBe(true);
    expect(res.meta?.permission).toBe("write");
    expect(requests).toHaveLength(0); // never prompted
  });

  it("auto-approves a non-allowlisted execute command without prompting", async () => {
    const ws = makeWorkspace();
    const { confirm, requests } = scriptedConfirm(false);
    const ctx = makeCtx(ws, { policy: { approvalMode: "auto" }, confirm });
    const res = await dispatcher.execute(call("run_command", { command: "echo hi" }), ctx);
    expect(res.ok).toBe(true);
    expect(requests).toHaveLength(0); // full-bypass tier: runs without a prompt
  });
});

describe("auto mode: dangerous commands are STILL refused", () => {
  it.each([
    ["sudo rm -rf /", "sudo"],
    ["rm -rf /", "rm -rf /"],
    ["git push origin main --force", "git push"],
  ])("refuses %s without ever prompting", async (command) => {
    const ws = makeWorkspace();
    const { confirm, requests } = scriptedConfirm(true); // would-be "yes"
    const ctx = makeCtx(ws, { policy: { approvalMode: "auto" }, confirm });
    const res = await dispatcher.execute(call("run_command", { command }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_dangerous");
    expect(requests).toHaveLength(0); // dangerous is never run, never prompted
  });

  it("an allow rule cannot rescue a dangerous command in auto mode", async () => {
    const ws = makeWorkspace();
    const { confirm } = scriptedConfirm(true);
    const ctx = makeCtx(ws, {
      policy: {
        approvalMode: "auto",
        rules: [{ tool: "run_command", action: "allow" }],
      },
      confirm,
    });
    const res = await dispatcher.execute(call("run_command", { command: "sudo reboot" }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_dangerous");
  });

  it("a prior allow-for-session entry cannot rescue a dangerous command in auto mode", async () => {
    const ws = makeWorkspace();
    const { confirm } = scriptedConfirm(true);
    const ctx = makeCtx(ws, {
      policy: { approvalMode: "auto", sessionAllowlist: ["sudo"] },
      confirm,
    });
    const res = await dispatcher.execute(call("run_command", { command: "sudo rm -rf /tmp" }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_dangerous");
  });
});

describe("auto mode: env-changing actions STILL require confirmation", () => {
  it("a package install confirms even with -y, and a refusal blocks it", async () => {
    const ws = makeWorkspace();
    const deny = scriptedConfirm(false);
    const ctx = makeCtx(ws, { policy: { approvalMode: "auto" }, confirm: deny.confirm });
    const res = await dispatcher.execute(call("run_command", { command: "pnpm install left-pad" }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_by_user");
    expect(deny.requests).toHaveLength(1);
    expect(deny.requests[0]?.permission).toBe("env");
    expect(deny.requests[0]?.command).toBe("pnpm install left-pad"); // raw, verbatim
  });

  it("web_fetch is env-gated and confirms even with -y, and a refusal blocks it", async () => {
    const ws = makeWorkspace();
    const deny = scriptedConfirm(false);
    const ctx = makeCtx(ws, { policy: { approvalMode: "auto" }, confirm: deny.confirm });
    // No network is reached: the env gate prompts BEFORE run(), and the user's
    // refusal blocks the fetch — so the test stays deterministic.
    const res = await dispatcher.execute(call("web_fetch", { url: "https://example.com/docs" }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_by_user");
    expect(deny.requests).toHaveLength(1);
    expect(deny.requests[0]?.permission).toBe("env");
  });
});
