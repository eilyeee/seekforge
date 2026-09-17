/**
 * Keypress → answer for the permission panel, as a pure function so every
 * branch (reason input, scrolling, hunk selection, the y/a/A/n answers) is
 * testable without Ink. The app applies the returned outcome.
 */

import type { ConfirmResult, PermissionRequest } from "@seekforge/shared";
import type { KeyStroke } from "./keymap.js";
import { permissionResultForKey } from "./model.js";
import {
  bodyRowCount,
  clampOffset,
  denyWithReason,
  MAX_DENY_REASON_CHARS,
  PERMISSION_BODY_HEIGHT,
  permissionBody,
} from "./permission-view.js";

/** Panel-local UI state; reset whenever a new request arrives. */
export type PermissionUi = {
  /** The deny reason being typed, or undefined when not typing one. */
  reason?: string;
  scroll: number;
  /** Selected hunk indices (multi-hunk requests only). */
  hunks: number[];
};

export type PermissionKeyOutcome =
  | { kind: "resolve"; result: ConfirmResult }
  | { kind: "update"; ui: PermissionUi }
  | { kind: "open-ide" }
  | { kind: "ignore" };

const SCROLL_KEYS = new Set(["up", "down", "pageup", "pagedown"]);

function scrolled(request: PermissionRequest, ui: PermissionUi, name: string): PermissionUi {
  const rows = bodyRowCount(permissionBody(request));
  const step =
    name === "up" ? -1 : name === "down" ? 1 : name === "pageup" ? -PERMISSION_BODY_HEIGHT : PERMISSION_BODY_HEIGHT;
  return { ...ui, scroll: clampOffset(ui.scroll + step, rows) };
}

export function permissionKey(
  request: PermissionRequest,
  ui: PermissionUi,
  input: string,
  stroke: KeyStroke,
): PermissionKeyOutcome {
  // Typing a deny reason captures every key until Enter or Esc.
  if (ui.reason !== undefined) {
    if (stroke.name === "return") return { kind: "resolve", result: denyWithReason(ui.reason) };
    if (stroke.name === "escape") {
      const { reason: _dropped, ...rest } = ui;
      return { kind: "update", ui: rest };
    }
    if (stroke.name === "backspace" || stroke.name === "delete") {
      return { kind: "update", ui: { ...ui, reason: Array.from(ui.reason).slice(0, -1).join("") } };
    }
    if (stroke.name === undefined && !stroke.ctrl && !stroke.meta && input.length > 0) {
      const next = (ui.reason + input.replace(/[\r\n\t]+/g, " ")).slice(0, MAX_DENY_REASON_CHARS);
      return { kind: "update", ui: { ...ui, reason: next } };
    }
    return { kind: "ignore" };
  }

  if (stroke.name === "tab" || (input === "N" && !stroke.ctrl && !stroke.meta)) {
    return { kind: "update", ui: { ...ui, reason: "" } };
  }
  if (stroke.name !== undefined && SCROLL_KEYS.has(stroke.name)) {
    return { kind: "update", ui: scrolled(request, ui, stroke.name) };
  }
  if (input === "o" && !stroke.ctrl && !stroke.meta && stroke.name === undefined) return { kind: "open-ide" };

  const hunks = request.hunks;
  if (hunks && hunks.length > 1) {
    if (/^[1-9]$/.test(input)) {
      const index = Number(input) - 1;
      if (index >= hunks.length) return { kind: "ignore" };
      const next = ui.hunks.includes(index)
        ? ui.hunks.filter((i) => i !== index)
        : [...ui.hunks, index].sort((a, b) => a - b);
      return { kind: "update", ui: { ...ui, hunks: next } };
    }
    if (input.toLowerCase() === "a") return { kind: "update", ui: { ...ui, hunks: hunks.map((h) => h.index) } };
    if (input.toLowerCase() === "y") {
      if (ui.hunks.length === hunks.length) return { kind: "resolve", result: true };
      if (ui.hunks.length > 0) return { kind: "resolve", result: { allow: true, selectedHunks: [...ui.hunks] } };
      return { kind: "resolve", result: false };
    }
    return { kind: "resolve", result: false };
  }

  return {
    kind: "resolve",
    result: permissionResultForKey(input, request.rememberRule !== undefined, request.sessionGrantable !== false),
  };
}

/** The UI state a freshly shown request starts in. */
export function initialPermissionUi(request: PermissionRequest, initialScroll: number): PermissionUi {
  return { scroll: initialScroll, hunks: (request.hunks ?? []).map((h) => h.index) };
}
