/**
 * Declarative keybindings: one table from (scope, keystroke) to an action id,
 * so bindings are testable data instead of nested if-trees in components.
 *
 * Input routing order (app.tsx): permission panel → top overlay → composer;
 * "global" bindings are checked last in every scope.
 */

/** Normalized keystroke (subset of Ink's useInput signature we care about). */
export type KeyStroke = {
  /** Printable input, lowercased for matching when ctrl is held. */
  input: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  /** Named non-printable key, mirroring Ink's key booleans. */
  name?:
    | "return"
    | "escape"
    | "tab"
    | "up"
    | "down"
    | "left"
    | "right"
    | "pageup"
    | "pagedown"
    | "backspace"
    | "delete";
};

export type Scope = "permission" | "overlay" | "composer" | "global";

/**
 * Every action a binding can name, grouped by the scope that executes it. The
 * keybindings loader validates user files against this list, so an action added
 * here is rebindable without a second allowlist to forget.
 */
export const SCOPE_ACTIONS = {
  composer: [
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
    "paste-image",
  ],
  overlay: ["overlay-up", "overlay-down", "overlay-accept", "overlay-close"],
  global: [
    "cancel-or-quit",
    "cycle-approval",
    "scroll-up",
    "scroll-down",
    "scroll-latest",
    "toggle-verbose",
    "detach-run",
    "suspend",
    "tab-new",
    "tab-cycle",
    "toggle-sidebar",
    "toggle-pager",
    "model-picker",
    "toggle-thinking",
  ],
} as const;

export type ActionId = (typeof SCOPE_ACTIONS)[keyof typeof SCOPE_ACTIONS][number];

export const ACTION_IDS: readonly ActionId[] = [
  ...SCOPE_ACTIONS.composer,
  ...SCOPE_ACTIONS.overlay,
  ...SCOPE_ACTIONS.global,
];

/** The scope whose handler runs `action` (composer actions may also sit in global). */
export function actionScope(action: ActionId): Exclude<Scope, "permission"> {
  if ((SCOPE_ACTIONS.overlay as readonly string[]).includes(action)) return "overlay";
  if ((SCOPE_ACTIONS.composer as readonly string[]).includes(action)) return "composer";
  return "global";
}

/**
 * One binding. `rest` makes it a chord: `key` is the first stroke and `rest`
 * the strokes after it, e.g. "ctrl+x ctrl+e" = key ctrl+x, rest [ctrl+e].
 */
export type Binding = { scope: Scope; key: KeyStroke; action: ActionId; rest?: readonly KeyStroke[] };

export const KEYMAP: ReadonlyArray<Binding> = [
  // Overlay (palette / file picker): navigate, accept, dismiss.
  { scope: "overlay", key: { input: "", name: "up" }, action: "overlay-up" },
  { scope: "overlay", key: { input: "", name: "down" }, action: "overlay-down" },
  { scope: "overlay", key: { input: "", name: "tab" }, action: "overlay-accept" },
  { scope: "overlay", key: { input: "", name: "return" }, action: "overlay-accept" },
  { scope: "overlay", key: { input: "", name: "escape" }, action: "overlay-close" },

  // Composer.
  { scope: "composer", key: { input: "", name: "return" }, action: "submit" },
  { scope: "composer", key: { input: "j", ctrl: true }, action: "newline" },
  { scope: "composer", key: { input: "", name: "up" }, action: "history-up" },
  { scope: "composer", key: { input: "", name: "down" }, action: "history-down" },
  { scope: "composer", key: { input: "", name: "left" }, action: "cursor-left" },
  { scope: "composer", key: { input: "", name: "right" }, action: "cursor-right" },
  { scope: "composer", key: { input: "u", ctrl: true }, action: "clear-line" },
  { scope: "composer", key: { input: "", name: "backspace" }, action: "delete-back" },
  { scope: "composer", key: { input: "", name: "delete" }, action: "delete-back" },
  { scope: "composer", key: { input: "g", ctrl: true }, action: "external-editor" },
  { scope: "composer", key: { input: "r", ctrl: true }, action: "history-search" },
  { scope: "composer", key: { input: "", name: "tab" }, action: "path-complete" },
  { scope: "composer", key: { input: "v", ctrl: true }, action: "paste-image" },

  // Global (any scope, checked after the scope's own bindings).
  { scope: "global", key: { input: "c", ctrl: true }, action: "cancel-or-quit" },
  { scope: "global", key: { input: "", name: "tab", shift: true }, action: "cycle-approval" },
  { scope: "global", key: { input: "", name: "pageup" }, action: "scroll-up" },
  { scope: "global", key: { input: "", name: "pagedown" }, action: "scroll-down" },
  { scope: "global", key: { input: "o", ctrl: true }, action: "toggle-verbose" },
  { scope: "global", key: { input: "b", ctrl: true }, action: "detach-run" },
  { scope: "global", key: { input: "z", ctrl: true }, action: "suspend" },
  { scope: "global", key: { input: "n", ctrl: true }, action: "tab-new" },
  { scope: "global", key: { input: "t", ctrl: true }, action: "tab-cycle" },
  { scope: "global", key: { input: "e", ctrl: true }, action: "toggle-sidebar" },
  { scope: "global", key: { input: "l", ctrl: true }, action: "toggle-pager" },
  // Alt/Option chords; terminals that send ESC-prefixed Alt are handled by
  // esc-prefix.ts before the stroke gets here.
  { scope: "global", key: { input: "p", meta: true }, action: "model-picker" },
  { scope: "global", key: { input: "t", meta: true }, action: "toggle-thinking" },
];

/** Ink useInput key object, structurally (so we don't import ink here). */
export type InkKey = {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageUp: boolean;
  pageDown: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
};

/** Normalizes Ink's (input, key) pair into a KeyStroke. */
export function toStroke(input: string, key: InkKey): KeyStroke {
  const name = key.return
    ? "return"
    : key.escape
      ? "escape"
      : key.tab
        ? "tab"
        : key.upArrow
          ? "up"
          : key.downArrow
            ? "down"
            : key.leftArrow
              ? "left"
              : key.rightArrow
                ? "right"
                : key.pageUp
                  ? "pageup"
                  : key.pageDown
                    ? "pagedown"
                    : key.backspace
                      ? "backspace"
                      : key.delete
                        ? "delete"
                        : undefined;
  // Ink reports every Esc press with meta set (its parser cannot tell a bare
  // Esc from an Alt prefix), which made no escape binding ever match.
  const meta = key.meta && !key.escape;
  return {
    input: key.ctrl ? input.toLowerCase() : input,
    ...(key.ctrl ? { ctrl: true } : {}),
    ...(key.shift ? { shift: true } : {}),
    ...(meta ? { meta: true } : {}),
    ...(name ? { name } : {}),
  };
}

function matches(binding: KeyStroke, stroke: KeyStroke): boolean {
  if (binding.name !== undefined || stroke.name !== undefined) {
    if (binding.name !== stroke.name) return false;
  } else if (binding.input !== stroke.input) {
    return false;
  }
  if ((binding.ctrl ?? false) !== (stroke.ctrl ?? false)) return false;
  if ((binding.shift ?? false) !== (stroke.shift ?? false)) return false;
  if ((binding.meta ?? false) !== (stroke.meta ?? false)) return false;
  return true;
}

/**
 * Resolves a keystroke in a scope: the scope's own bindings first, then
 * global ones. Returns undefined when nothing matches (the composer then
 * treats printable input as text insertion). Pass a merged table (user
 * keybindings applied) to override the built-in KEYMAP.
 */
export function resolveAction(
  scope: Scope,
  stroke: KeyStroke,
  table: ReadonlyArray<Binding> = KEYMAP,
): ActionId | undefined {
  for (const b of table) {
    if (!b.rest && b.scope === scope && matches(b.key, stroke)) return b.action;
  }
  for (const b of table) {
    if (!b.rest && b.scope === "global" && matches(b.key, stroke)) return b.action;
  }
  return undefined;
}

export type ChordResult = { kind: "action"; action: ActionId } | { kind: "pending" } | { kind: "none" };

/**
 * Resolves a stroke SEQUENCE against the chord bindings of `scope` (then
 * global): "action" when it completes one, "pending" while it is a proper
 * prefix of one, "none" otherwise. Single-stroke bindings are not consulted —
 * a one-stroke `strokes` only ever answers "pending" or "none".
 */
export function resolveChord(
  scope: Scope,
  strokes: readonly KeyStroke[],
  table: ReadonlyArray<Binding> = KEYMAP,
): ChordResult {
  let pending = false;
  for (const wanted of [scope, "global"] as const) {
    for (const b of table) {
      if (!b.rest || b.scope !== wanted) continue;
      const sequence = [b.key, ...b.rest];
      if (strokes.length > sequence.length) continue;
      if (!strokes.every((stroke, i) => matches(sequence[i] as KeyStroke, stroke))) continue;
      if (strokes.length === sequence.length) return { kind: "action", action: b.action };
      pending = true;
    }
  }
  return pending ? { kind: "pending" } : { kind: "none" };
}

/** Human-readable key spec ("ctrl+x", "alt+p", "shift+tab") for help and hints. */
export function formatStroke(stroke: KeyStroke): string {
  const parts: string[] = [];
  if (stroke.ctrl) parts.push("ctrl");
  if (stroke.meta) parts.push("alt");
  if (stroke.shift) parts.push("shift");
  // parseKeySpec stores a shifted letter uppercased; print it the way it is typed.
  parts.push(stroke.name ?? (stroke.shift ? stroke.input.toLowerCase() : stroke.input));
  return parts.join("+");
}

/** Every stroke of a binding, formatted ("ctrl+x ctrl+e" for a chord). */
export function formatBinding(binding: Binding): string {
  return [binding.key, ...(binding.rest ?? [])].map(formatStroke).join(" ");
}
