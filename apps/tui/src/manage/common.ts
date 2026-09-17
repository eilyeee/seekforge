/**
 * Shared pieces of the interactive management overlays (/permissions, /mcp,
 * /agents, /hooks, /skills, /plugins): list movement and one-line text input.
 * Each overlay keeps its own state and key handler next to this file; the app
 * only applies the effects they return.
 */

import type { KeyStroke } from "../keymap.js";

/** Wrapping list movement; an empty list stays at 0. */
export function moveIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/** Up/down/page keys as a list delta, or undefined for any other key. */
export function listDelta(stroke: KeyStroke): number | undefined {
  switch (stroke.name) {
    case "up":
      return -1;
    case "down":
      return 1;
    case "pageup":
      return -8;
    case "pagedown":
      return 8;
    default:
      return undefined;
  }
}

/** A printable keypress (no control characters, no modifiers, not a named key). */
export function isPrintable(input: string, stroke: KeyStroke): boolean {
  return (
    stroke.name === undefined && !stroke.ctrl && !stroke.meta && input.length > 0 && !/[\x00-\x1f\x7f]/.test(input)
  );
}

/**
 * Applies a text-editing key to a one-line field: printable input appends,
 * Backspace/Delete remove the last character. Returns undefined for any other
 * key so the caller can treat it as navigation.
 */
export function editLine(text: string, input: string, stroke: KeyStroke, max = 200): string | undefined {
  if (stroke.name === "backspace" || stroke.name === "delete") return Array.from(text).slice(0, -1).join("");
  if (isPrintable(input, stroke))
    return Array.from(text + input)
      .slice(0, max)
      .join("");
  return undefined;
}

/** A one-line status the overlay shows under its list. */
export type ManageMessage = { text: string; tone: "dim" | "error" | "ok" };
