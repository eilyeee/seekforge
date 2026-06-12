/**
 * User-configurable keybinding overrides, loaded from
 * ~/.seekforge/keybindings.json and <workspace>/.seekforge/keybindings.json
 * (project wins per scope+action). The file maps scopes to action→key-spec:
 *
 *   { "composer": { "newline": "ctrl+j" }, "global": { "cycle-approval": "shift+tab" } }
 *
 * Specs are parsed into keymap.ts KeyStroke values and merged over the
 * built-in KEYMAP with mergeKeymap (an override replaces every base binding
 * for the same scope+action). keymap.ts itself stays untouched.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ActionId, Binding, KeyStroke, Scope } from "./keymap.js";

/** A single user override: bind `key` to `action` within `scope`. */
export type KeyOverride = { scope: Scope; action: ActionId; key: KeyStroke };

const NAMED_KEYS = new Set([
  "return",
  "escape",
  "tab",
  "up",
  "down",
  "left",
  "right",
  "pageup",
  "pagedown",
  "backspace",
  "delete",
]);

const MODIFIERS = new Set(["ctrl", "shift", "meta"]);

/**
 * Parses a key spec like "ctrl+j", "shift+tab", "escape", or "x" into a
 * KeyStroke. Returns null for empty, duplicate-modifier, multi-char unnamed,
 * or otherwise malformed specs.
 */
export function parseKeySpec(spec: string): KeyStroke | null {
  const parts = spec.trim().toLowerCase().split("+");
  if (parts.some((p) => p === "")) return null;

  let ctrl = false;
  let shift = false;
  let meta = false;
  const rest: string[] = [];
  for (const part of parts) {
    if (MODIFIERS.has(part)) {
      if ((part === "ctrl" && ctrl) || (part === "shift" && shift) || (part === "meta" && meta)) return null;
      if (part === "ctrl") ctrl = true;
      else if (part === "shift") shift = true;
      else meta = true;
    } else {
      rest.push(part);
    }
  }
  if (rest.length !== 1) return null;

  const key = rest[0] as string;
  let stroke: KeyStroke;
  if (NAMED_KEYS.has(key)) {
    stroke = { input: "", name: key as NonNullable<KeyStroke["name"]> };
  } else if ([...key].length === 1) {
    stroke = { input: key };
  } else {
    return null;
  }
  return {
    ...stroke,
    ...(ctrl ? { ctrl: true } : {}),
    ...(shift ? { shift: true } : {}),
    ...(meta ? { meta: true } : {}),
  };
}

const SCOPES: ReadonlySet<string> = new Set(["permission", "overlay", "composer", "global"]);

const ACTIONS: ReadonlySet<string> = new Set([
  "submit",
  "newline",
  "history-up",
  "history-down",
  "cursor-left",
  "cursor-right",
  "clear-line",
  "delete-back",
  "delete-forward",
  "external-editor",
  "history-search",
  "path-complete",
  "overlay-up",
  "overlay-down",
  "overlay-accept",
  "overlay-close",
  "cancel-or-quit",
  "cycle-approval",
  "scroll-up",
  "scroll-down",
  "scroll-latest",
]);

function readOverrides(path: string): KeyOverride[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];

  const overrides: KeyOverride[] = [];
  for (const [scope, actions] of Object.entries(raw as Record<string, unknown>)) {
    if (!SCOPES.has(scope)) continue;
    if (typeof actions !== "object" || actions === null || Array.isArray(actions)) continue;
    for (const [action, spec] of Object.entries(actions as Record<string, unknown>)) {
      if (!ACTIONS.has(action) || typeof spec !== "string") continue;
      const key = parseKeySpec(spec);
      if (key === null) continue;
      overrides.push({ scope: scope as Scope, action: action as ActionId, key });
    }
  }
  return overrides;
}

/**
 * Loads ~/.seekforge/keybindings.json and <workspace>/.seekforge/keybindings.json
 * and merges them (project wins per scope+action). Unknown scopes/actions and
 * unparsable specs are skipped silently; missing files yield [].
 */
export function loadKeybindings(workspace: string, homeDir = homedir()): KeyOverride[] {
  const global = readOverrides(join(homeDir, ".seekforge", "keybindings.json"));
  const project = readOverrides(join(workspace, ".seekforge", "keybindings.json"));
  const merged = global.filter((g) => !project.some((p) => p.scope === g.scope && p.action === g.action));
  return [...merged, ...project];
}

/**
 * Applies overrides to a base keymap: an override replaces every base binding
 * with the same scope+action (the replacement takes the first such slot), and
 * appends when none existed. Order is otherwise preserved.
 */
export function mergeKeymap(base: readonly Binding[], overrides: ReadonlyArray<KeyOverride>): Binding[] {
  const result: Binding[] = [];
  const pending = [...overrides];
  for (const binding of base) {
    const idx = pending.findIndex((o) => o.scope === binding.scope && o.action === binding.action);
    if (idx === -1) {
      // Drop base bindings shadowed by an already-consumed override too.
      if (overrides.some((o) => o.scope === binding.scope && o.action === binding.action)) continue;
      result.push(binding);
    } else {
      const o = pending[idx] as KeyOverride;
      pending.splice(idx, 1);
      result.push({ scope: o.scope, action: o.action, key: o.key });
    }
  }
  for (const o of pending) {
    result.push({ scope: o.scope, action: o.action, key: o.key });
  }
  return result;
}
