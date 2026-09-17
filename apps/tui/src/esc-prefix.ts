/**
 * Alt/Option as an ESC prefix.
 *
 * Most terminals send Alt+P as the two bytes "\x1bp" in one read, which Ink
 * already reports as meta+p. Some (tmux with a low escape-time, slow SSH
 * links, a few emulators) deliver the ESC and the letter as separate reads, and
 * Ink then reports a bare Esc followed by a plain "p" — Esc would interrupt the
 * run and the "p" would be typed into the composer.
 *
 * The joiner holds a bare Esc for a short window: a printable character inside
 * the window is delivered as meta+<char>, anything else (or the window
 * elapsing) delivers the Esc first. The window is far below human typing
 * speed, so a real Esc is only ever delayed, never lost.
 */

import type { InkKey } from "./keymap.js";

export const ESC_PREFIX_WINDOW_MS = 30;

export type KeyHandler = (input: string, key: InkKey) => void;

type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const DEFAULT_TIMERS: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A bare Esc press: Ink reports it with empty input and the escape flag. */
export function isBareEscape(input: string, key: InkKey): boolean {
  return key.escape && input === "";
}

/** The Alt+<char> event a split "ESC, char" pair stands for, or null. */
export function altFromSplit(input: string, key: InkKey): { input: string; key: InkKey } | null {
  if (!/^[\x21-\x7e]$/.test(input)) return null;
  if (key.ctrl || key.meta || key.escape || key.return || key.tab || key.backspace || key.delete) return null;
  return { input, key: { ...key, meta: true } };
}

export type EscapeJoiner = {
  feed: KeyHandler;
  dispose: () => void;
};

export function createEscapeJoiner(
  deliver: KeyHandler,
  windowMs = ESC_PREFIX_WINDOW_MS,
  timers: Timers = DEFAULT_TIMERS,
): EscapeJoiner {
  let pending: { key: InkKey; handle: unknown } | null = null;

  const flush = (): void => {
    if (!pending) return;
    const { key, handle } = pending;
    pending = null;
    timers.clear(handle);
    deliver("", key);
  };

  return {
    feed(input, key) {
      if (pending) {
        const alt = altFromSplit(input, key);
        if (alt) {
          timers.clear(pending.handle);
          pending = null;
          deliver(alt.input, alt.key);
          return;
        }
        flush();
      }
      if (isBareEscape(input, key)) {
        const handle = timers.set(() => {
          if (pending?.handle !== handle) return;
          pending = null;
          deliver("", key);
        }, windowMs);
        pending = { key, handle };
        return;
      }
      deliver(input, key);
    },
    dispose() {
      if (pending) timers.clear(pending.handle);
      pending = null;
    },
  };
}
