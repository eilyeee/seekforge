/**
 * User-configurable keybinding overrides, loaded from
 * ~/.seekforge/keybindings.json and <workspace>/.seekforge/keybindings.json
 * (project wins per scope+action). The file maps scopes to action→key-spec:
 *
 *   { "composer": { "newline": "ctrl+j", "external-editor": "ctrl+x ctrl+e" },
 *     "global": { "model-picker": "alt+m" } }
 *
 * Specs are parsed into keymap.ts KeyStroke values and merged over the
 * built-in KEYMAP with mergeKeymap (an override replaces every base binding
 * for the same scope+action). A space-separated spec is a chord. Anything the
 * loader cannot use is reported as a warning instead of being dropped silently.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  ACTION_IDS,
  actionScope,
  formatStroke,
  type ActionId,
  type Binding,
  type KeyStroke,
  type Scope,
} from "./keymap.js";
import { MAX_CONFIG_FILE_BYTES, readTextFileBounded } from "./bounded-file.js";

/** A single user override: bind `key` (followed by `rest`, for a chord) to `action` within `scope`. */
export type KeyOverride = { scope: Scope; action: ActionId; key: KeyStroke; rest?: KeyStroke[] };

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

const MODIFIERS = new Set(["ctrl", "shift", "meta", "alt", "option"]);
/** The longest chord a spec may describe. */
const MAX_CHORD_STROKES = 3;

/**
 * Parses a key spec like "ctrl+j", "shift+tab", "escape", or "x" into a
 * KeyStroke. Returns null for empty, duplicate-modifier, multi-char unnamed,
 * or otherwise malformed specs.
 */
export function parseKeySpec(spec: string): KeyStroke | null {
  // Split on the raw spec so the key char's case is preserved; only modifier
  // names and named keys are matched case-insensitively.
  const parts = spec.trim().split("+");
  if (parts.some((p) => p === "")) return null;

  let ctrl = false;
  let shift = false;
  let meta = false;
  const rest: string[] = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (MODIFIERS.has(lower)) {
      const isMeta = lower === "meta" || lower === "alt" || lower === "option";
      if ((lower === "ctrl" && ctrl) || (lower === "shift" && shift) || (isMeta && meta)) return null;
      if (lower === "ctrl") ctrl = true;
      else if (lower === "shift") shift = true;
      else meta = true;
    } else {
      rest.push(part);
    }
  }
  if (rest.length !== 1) return null;

  const raw = rest[0] as string;
  const lowerKey = raw.toLowerCase();
  let stroke: KeyStroke;
  if (NAMED_KEYS.has(lowerKey)) {
    stroke = { input: "", name: lowerKey as NonNullable<KeyStroke["name"]> };
  } else if ([...raw].length === 1) {
    // Mirror keymap.toStroke's normalization so a spec matches the stroke the
    // terminal actually delivers: ctrl lowercases the letter; a shifted letter
    // arrives in its uppercase form (e.g. Shift+A -> input "A").
    const input = ctrl ? raw.toLowerCase() : shift ? raw.toUpperCase() : raw;
    stroke = { input };
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

/**
 * Parses a key sequence: one stroke ("ctrl+e") or a space-separated chord
 * ("ctrl+x ctrl+e"). Returns null when any stroke is malformed or the chord is
 * longer than MAX_CHORD_STROKES.
 */
export function parseKeySequence(spec: string): KeyStroke[] | null {
  const parts = spec.trim().split(/\s+/);
  if (parts.length === 0 || parts.length > MAX_CHORD_STROKES || parts[0] === "") return null;
  const strokes: KeyStroke[] = [];
  for (const part of parts) {
    const stroke = parseKeySpec(part);
    if (stroke === null) return null;
    strokes.push(stroke);
  }
  return strokes;
}

const SCOPES: ReadonlySet<string> = new Set(["permission", "overlay", "composer", "global"]);
const ACTIONS: ReadonlySet<string> = new Set(ACTION_IDS);

/** What a keybindings file contributed, and every entry it could not use. */
export type KeybindingsReport = { overrides: KeyOverride[]; warnings: string[] };

/** Whether `action` runs when bound in `scope` (composer actions also accept global). */
function scopeRunsAction(scope: Scope, action: ActionId): boolean {
  const home = actionScope(action);
  return scope === home || (home === "composer" && scope === "global");
}

function readOverrides(path: string): KeybindingsReport {
  let text: string;
  try {
    text = readTextFileBounded(path, MAX_CONFIG_FILE_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { overrides: [], warnings: [] };
    return { overrides: [], warnings: [`${path}: unreadable (${(error as Error).message})`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { overrides: [], warnings: [`${path}: not valid JSON — no bindings loaded from it`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { overrides: [], warnings: [`${path}: the top level must be an object of scopes`] };
  }

  const overrides: KeyOverride[] = [];
  const warnings: string[] = [];
  for (const [scope, actions] of Object.entries(raw as Record<string, unknown>)) {
    if (!SCOPES.has(scope)) {
      warnings.push(`${path}: unknown scope "${scope}" (use composer, overlay or global)`);
      continue;
    }
    if (typeof actions !== "object" || actions === null || Array.isArray(actions)) {
      warnings.push(`${path}: "${scope}" must map action names to key specs`);
      continue;
    }
    for (const [action, spec] of Object.entries(actions as Record<string, unknown>)) {
      const where = `${path}: ${scope}.${action}`;
      if (!ACTIONS.has(action)) {
        warnings.push(`${where} — unknown action`);
        continue;
      }
      const id = action as ActionId;
      if (!scopeRunsAction(scope as Scope, id)) {
        warnings.push(`${where} — this action runs in the "${actionScope(id)}" scope`);
        continue;
      }
      if (typeof spec !== "string") {
        warnings.push(`${where} — the key spec must be a string`);
        continue;
      }
      const strokes = parseKeySequence(spec);
      if (strokes === null) {
        warnings.push(`${where} — cannot parse key spec "${spec}"`);
        continue;
      }
      if (strokes.length > 1 && scope === "overlay") {
        warnings.push(`${where} — chords are supported in the composer and global scopes only`);
        continue;
      }
      const [key, ...rest] = strokes as [KeyStroke, ...KeyStroke[]];
      overrides.push({ scope: scope as Scope, action: id, key, ...(rest.length > 0 ? { rest } : {}) });
    }
  }
  return { overrides, warnings };
}

/**
 * Loads ~/.seekforge/keybindings.json and <workspace>/.seekforge/keybindings.json
 * and merges them (project wins per scope+action), reporting every entry that
 * was skipped. Missing files contribute nothing and no warning.
 */
export function loadKeybindingsReport(workspace: string, homeDir = homedir()): KeybindingsReport {
  const global = readOverrides(join(homeDir, ".seekforge", "keybindings.json"));
  const project = readOverrides(join(workspace, ".seekforge", "keybindings.json"));
  const merged = global.overrides.filter(
    (g) => !project.overrides.some((p) => p.scope === g.scope && p.action === g.action),
  );
  return {
    overrides: [...merged, ...project.overrides],
    warnings: [...global.warnings, ...project.warnings],
  };
}

/** The usable overrides only (see loadKeybindingsReport for the diagnostics). */
export function loadKeybindings(workspace: string, homeDir = homedir()): KeyOverride[] {
  return loadKeybindingsReport(workspace, homeDir).overrides;
}

/**
 * A chord's first stroke is consumed while the chord is pending, so a
 * single-stroke binding on the same key in the composer or global scope can
 * never fire. Reported against the merged table, built-ins included.
 */
export function chordShadowWarnings(table: readonly Binding[]): string[] {
  const warnings: string[] = [];
  for (const chord of table) {
    if (!chord.rest) continue;
    for (const single of table) {
      if (single.rest || single.scope === "overlay" || !sameStroke(single.key, chord.key)) continue;
      warnings.push(
        `keybindings: ${single.scope}.${single.action} (${formatStroke(single.key)}) is shadowed by the chord for ${chord.action}`,
      );
    }
  }
  return warnings;
}

function sameStroke(a: KeyStroke, b: KeyStroke): boolean {
  return (
    a.input === b.input &&
    a.name === b.name &&
    (a.ctrl ?? false) === (b.ctrl ?? false) &&
    (a.shift ?? false) === (b.shift ?? false) &&
    (a.meta ?? false) === (b.meta ?? false)
  );
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
      result.push(toBinding(o));
    }
  }
  for (const o of pending) result.push(toBinding(o));
  return result;
}

function toBinding(o: KeyOverride): Binding {
  return { scope: o.scope, action: o.action, key: o.key, ...(o.rest ? { rest: o.rest } : {}) };
}
