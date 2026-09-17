import type { PermissionRequest } from "@seekforge/shared";
import { afterEach, describe, expect, it } from "vitest";
import { initialPermissionUi, permissionKey, type PermissionUi } from "../permission-keys.js";
import {
  denyWithReason,
  initialBodyOffset,
  markdownWindow,
  MAX_DENY_REASON_CHARS,
  PERMISSION_BODY_HEIGHT,
  permissionBody,
  permissionHints,
} from "../permission-view.js";
import { setLocale } from "../strings.js";

afterEach(() => setLocale("en"));

const command: PermissionRequest = {
  toolName: "run_command",
  permission: "execute",
  description: "Run a command",
  command: "pnpm test",
  rememberRule: { action: "allow", tool: "run_command", match: "pnpm test" },
};

const envTool: PermissionRequest = {
  toolName: "browser_navigate",
  permission: "env",
  description: "Open https://example.test",
  sessionGrantable: false,
};

const longDiff = [
  "--- a/big.ts",
  "+++ b/big.ts",
  "@@ -1,60 +1,60 @@",
  ...Array.from({ length: 40 }, (_, i) => ` line ${i}`),
  "-old",
  "+new",
  ...Array.from({ length: 19 }, (_, i) => ` tail ${i}`),
].join("\n");

const editRequest: PermissionRequest = {
  toolName: "apply_patch",
  permission: "write",
  description: "Apply 1 edit(s) to big.ts",
  path: "big.ts",
  preview: { path: "big.ts", diff: longDiff },
};

const plan = [
  "# Plan",
  "",
  "1. Read the code",
  "",
  "```ts",
  ...Array.from({ length: 30 }, (_, i) => `step(${i});`),
  "```",
  "",
  "Done.",
].join("\n");

const planRequest: PermissionRequest = {
  toolName: "exit_plan_mode",
  permission: "readonly",
  description: plan,
};

const ui = (over: Partial<PermissionUi> = {}): PermissionUi => ({ scroll: 0, hunks: [], ...over });

describe("permissionBody", () => {
  it("classifies diffs, markdown plans and plain requests", () => {
    expect(permissionBody(editRequest).kind).toBe("diff");
    expect(permissionBody(planRequest)).toEqual({ kind: "markdown", text: plan });
    expect(permissionBody({ ...planRequest, toolName: "other", preview: { path: "", diff: "## Plan\n- a" } })).toEqual({
      kind: "markdown",
      text: "## Plan\n- a",
    });
    expect(permissionBody(command).kind).toBe("plain");
  });

  it("opens a full-file diff near the first change", () => {
    expect(initialBodyOffset(permissionBody(editRequest))).toBe(40);
    expect(initialBodyOffset(permissionBody(planRequest))).toBe(0);
  });
});

describe("markdownWindow", () => {
  it("reopens a code fence the window starts inside", () => {
    const window = markdownWindow(plan, 10);
    expect(window.split("\n")[0]).toBe("```ts");
    expect(window.split("\n")).toHaveLength(PERMISSION_BODY_HEIGHT + 1);
    expect(markdownWindow(plan, 0).split("\n")[0]).toBe("# Plan");
  });

  it("clamps the offset to the last full page", () => {
    const lines = plan.split("\n").length;
    expect(markdownWindow(plan, 999)).toBe(markdownWindow(plan, lines - PERMISSION_BODY_HEIGHT));
  });
});

describe("permissionHints", () => {
  it("lists only the answers the request supports", () => {
    expect(permissionHints(command)).toBe("y allow · a allow session · A always · N reason · n deny");
    expect(permissionHints(envTool)).toBe("y allow · N reason · n deny");
    expect(permissionHints(editRequest, { ideConnected: true })).toBe(
      "y allow · a allow session · N reason · n deny · ↑↓ PgUp PgDn scroll · o diff in IDE",
    );
    expect(permissionHints(command, { typingReason: true })).toBe("type the reason · Enter deny · Esc back");
  });
});

describe("permissionKey", () => {
  it("answers y / a / A / anything else as before", () => {
    expect(permissionKey(command, ui(), "y", { input: "y" })).toEqual({ kind: "resolve", result: true });
    expect(permissionKey(command, ui(), "a", { input: "a" })).toEqual({
      kind: "resolve",
      result: { allow: true, remember: "session" },
    });
    expect(permissionKey(command, ui(), "A", { input: "A", shift: true })).toEqual({
      kind: "resolve",
      result: { allow: true, remember: "always" },
    });
    expect(permissionKey(command, ui(), "n", { input: "n" })).toEqual({ kind: "resolve", result: false });
  });

  it("never offers a session grant the request cannot carry", () => {
    expect(permissionKey(envTool, ui(), "a", { input: "a" })).toEqual({ kind: "resolve", result: true });
    expect(permissionKey(envTool, ui(), "A", { input: "A", shift: true })).toEqual({ kind: "resolve", result: true });
  });

  it("collects a deny reason with N or Tab and sends it on Enter", () => {
    let state = ui();
    const open = permissionKey(command, state, "N", { input: "N", shift: true });
    expect(open).toEqual({ kind: "update", ui: ui({ reason: "" }) });
    state = (open as { ui: PermissionUi }).ui;
    for (const ch of "use pnpm") {
      state = (permissionKey(command, state, ch, { input: ch }) as { ui: PermissionUi }).ui;
    }
    // Keys that would otherwise answer the prompt are text while typing.
    state = (permissionKey(command, state, "y", { input: "y" }) as { ui: PermissionUi }).ui;
    state = (permissionKey(command, state, "", { input: "", name: "backspace" }) as { ui: PermissionUi }).ui;
    expect(state.reason).toBe("use pnpm");
    expect(permissionKey(command, state, "", { input: "", name: "return" })).toEqual({
      kind: "resolve",
      result: { allow: false, feedback: "use pnpm" },
    });
    expect(permissionKey(command, ui(), "", { input: "", name: "tab" })).toEqual({
      kind: "update",
      ui: ui({ reason: "" }),
    });
  });

  it("leaves reason mode on Esc and treats an empty reason as a plain deny", () => {
    expect(permissionKey(command, ui({ reason: "x" }), "", { input: "", name: "escape" })).toEqual({
      kind: "update",
      ui: ui(),
    });
    expect(permissionKey(command, ui({ reason: "  " }), "", { input: "", name: "return" })).toEqual({
      kind: "resolve",
      result: false,
    });
    expect(denyWithReason("x".repeat(MAX_DENY_REASON_CHARS + 50))).toEqual({
      allow: false,
      feedback: "x".repeat(MAX_DENY_REASON_CHARS),
    });
  });

  it("scrolls instead of denying on navigation keys", () => {
    const start = initialPermissionUi(editRequest, 0);
    const down = permissionKey(editRequest, start, "", { input: "", name: "pagedown" });
    expect(down).toEqual({ kind: "update", ui: { ...start, scroll: PERMISSION_BODY_HEIGHT } });
    const clamped = permissionKey(editRequest, { ...start, scroll: 1000 }, "", { input: "", name: "down" });
    // 3 header lines + 40 + 2 changed + 19 = 64 rows.
    expect(clamped).toEqual({ kind: "update", ui: { ...start, scroll: 64 - PERMISSION_BODY_HEIGHT } });
    expect(permissionKey(editRequest, start, "", { input: "", name: "up" })).toEqual({ kind: "update", ui: start });
  });

  it("asks the app to open the IDE diff on o without answering", () => {
    expect(permissionKey(editRequest, ui(), "o", { input: "o" })).toEqual({ kind: "open-ide" });
  });

  it("keeps multi-hunk selection working", () => {
    const req: PermissionRequest = {
      ...editRequest,
      hunks: [
        { index: 0, preview: "a" },
        { index: 1, preview: "b" },
        { index: 2, preview: "c" },
      ],
    };
    const all = initialPermissionUi(req, 0);
    expect(all.hunks).toEqual([0, 1, 2]);
    const without2 = permissionKey(req, all, "2", { input: "2" });
    expect(without2).toEqual({ kind: "update", ui: { ...all, hunks: [0, 2] } });
    expect(permissionKey(req, { ...all, hunks: [0, 2] }, "y", { input: "y" })).toEqual({
      kind: "resolve",
      result: { allow: true, selectedHunks: [0, 2] },
    });
    expect(permissionKey(req, all, "y", { input: "y" })).toEqual({ kind: "resolve", result: true });
    expect(permissionKey(req, { ...all, hunks: [] }, "y", { input: "y" })).toEqual({ kind: "resolve", result: false });
    expect(permissionKey(req, all, "9", { input: "9" })).toEqual({ kind: "ignore" });
    expect(permissionKey(req, { ...all, hunks: [2] }, "1", { input: "1" })).toEqual({
      kind: "update",
      ui: { ...all, hunks: [0, 2] },
    });
    expect(permissionKey(req, all, "x", { input: "x" })).toEqual({ kind: "resolve", result: false });
  });
});
