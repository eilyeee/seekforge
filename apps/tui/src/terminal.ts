/**
 * Terminal integration: window title (OSC 0) and SGR mouse-wheel support.
 * The app writes MOUSE_ENABLE on mount and MOUSE_DISABLE on exit, then feeds
 * raw stdin chunks through parseMouseWheel to drive transcript scrolling.
 */

const DEFAULT_TITLE = "seekforge";

/** Button-event tracking + SGR extended coordinates. */
export const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
/** Matching reset, reverse order. */
export const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1000l";

/** OSC 0 sequence for `title`, control characters stripped. Pure. */
export function buildTitleSequence(title: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = title.replace(/[\x00-\x1f\x7f]/g, "");
  return `\x1b]0;${clean}\x07`;
}

/** Sets the terminal window title. No-op when stdout is not a TTY. */
export function setTerminalTitle(title: string): void {
  if (!process.stdout.isTTY) return;
  try {
    process.stdout.write(buildTitleSequence(title));
  } catch {
    // never let title updates crash the app
  }
}

/** Resets the terminal title back to "seekforge". */
export function clearTerminalTitle(): void {
  setTerminalTitle(DEFAULT_TITLE);
}

// Ink consumes the leading ESC before handing the rest to useInput, so the
// chunk may arrive as "[<65;60;39M" without the escape byte: match both.
const SGR_WHEEL = /(?:\x1b)?\[<(64|65);\d+;\d+[Mm]/;
const SGR_ANY = /(?:\x1b)?\[<\d+;\d+;\d+[Mm]/;

/**
 * Scans a raw stdin chunk for an SGR mouse-wheel event:
 * [ < 64 ; x ; y M → "up", [ < 65 ; x ; y M → "down" (leading ESC optional —
 * Ink strips it). The chunk may contain multiple or partial sequences; the
 * first wheel match wins. Anything else → null.
 */
export function parseMouseWheel(input: string): "up" | "down" | null {
  const match = SGR_WHEEL.exec(input);
  if (!match) return null;
  return match[1] === "64" ? "up" : "down";
}

/**
 * True when the chunk contains ANY SGR mouse event (clicks, releases, drags).
 * The app swallows these so they never reach the composer as literal text
 * like "[<65;60;39M".
 */
export function isMouseEvent(input: string): boolean {
  return SGR_ANY.test(input);
}
