// Regression tests for the permission-flag → ApprovalMode mapping (the pure
// helper extracted from run.ts). No vitest in apps/cli, so — matching the other
// tests here — this is a dependency-free runner (run via `tsx`): each case
// asserts with node:assert and exits non-zero on the first failure.

import assert from "node:assert/strict";
import {
  resolvePermissionMode,
  UnknownPermissionModeError,
} from "../permission-mode.js";

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  }
}

// --- boolean flags (no --permission-mode) -----------------------------------
test("no flags → confirm", () => {
  const r = resolvePermissionMode({});
  assert.equal(r.approvalMode, "confirm");
  assert.equal(r.planFromMode, false);
});

test("-y → auto", () => {
  const r = resolvePermissionMode({ yes: true });
  assert.equal(r.approvalMode, "auto");
  assert.equal(r.planFromMode, false);
});

test("--dangerously-skip-permissions → auto", () => {
  const r = resolvePermissionMode({ dangerouslySkipPermissions: true });
  assert.equal(r.approvalMode, "auto");
  assert.equal(r.planFromMode, false);
});

// --- --permission-mode name mapping -----------------------------------------
test("--permission-mode default → confirm", () => {
  assert.equal(resolvePermissionMode({ permissionMode: "default" }).approvalMode, "confirm");
});

test("--permission-mode confirm (native) → confirm", () => {
  assert.equal(resolvePermissionMode({ permissionMode: "confirm" }).approvalMode, "confirm");
});

test("--permission-mode acceptEdits → acceptEdits", () => {
  assert.equal(resolvePermissionMode({ permissionMode: "acceptEdits" }).approvalMode, "acceptEdits");
});

test("--permission-mode bypassPermissions → auto", () => {
  assert.equal(resolvePermissionMode({ permissionMode: "bypassPermissions" }).approvalMode, "auto");
});

test("--permission-mode auto (native) → auto", () => {
  assert.equal(resolvePermissionMode({ permissionMode: "auto" }).approvalMode, "auto");
});

test("--permission-mode plan → confirm + plan-first", () => {
  const r = resolvePermissionMode({ permissionMode: "plan" });
  assert.equal(r.approvalMode, "confirm");
  assert.equal(r.planFromMode, true);
});

// --- precedence: --permission-mode overrides -y -----------------------------
test("--permission-mode overrides -y (default beats -y → confirm)", () => {
  const r = resolvePermissionMode({ yes: true, permissionMode: "default" });
  assert.equal(r.approvalMode, "confirm");
  assert.equal(r.planFromMode, false);
});

test("--permission-mode overrides --dangerously-skip-permissions (acceptEdits)", () => {
  const r = resolvePermissionMode({
    dangerouslySkipPermissions: true,
    permissionMode: "acceptEdits",
  });
  assert.equal(r.approvalMode, "acceptEdits");
});

test("--permission-mode plan overrides -y → confirm + plan-first", () => {
  const r = resolvePermissionMode({ yes: true, permissionMode: "plan" });
  assert.equal(r.approvalMode, "confirm");
  assert.equal(r.planFromMode, true);
});

// --- unknown mode -----------------------------------------------------------
test("unknown --permission-mode throws UnknownPermissionModeError carrying the mode", () => {
  assert.throws(
    () => resolvePermissionMode({ permissionMode: "bogus" }),
    (err: unknown) =>
      err instanceof UnknownPermissionModeError && err.mode === "bogus",
  );
});

test("an unknown mode is rejected even when -y is set (no silent fallback to auto)", () => {
  assert.throws(() => resolvePermissionMode({ yes: true, permissionMode: "nope" }));
});

console.log(`${passed} permission-mode tests passed`);
