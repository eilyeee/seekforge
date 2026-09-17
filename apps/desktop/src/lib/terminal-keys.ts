/**
 * Keyboard → terminal input bytes for the Desktop terminal panel, the subset
 * an xterm in normal cursor mode sends. Pure; unit-tested.
 */

const ESC = String.fromCharCode(0x1b);

export type KeyLike = { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean };

const NAMED: Record<string, string> = {
  Enter: "\r",
  Backspace: String.fromCharCode(0x7f),
  Tab: "\t",
  Escape: ESC,
  ArrowUp: `${ESC}[A`,
  ArrowDown: `${ESC}[B`,
  ArrowRight: `${ESC}[C`,
  ArrowLeft: `${ESC}[D`,
  Home: `${ESC}[H`,
  End: `${ESC}[F`,
  Delete: `${ESC}[3~`,
  PageUp: `${ESC}[5~`,
  PageDown: `${ESC}[6~`,
};

/**
 * The bytes a key press sends, or null when the terminal should not consume
 * it (Cmd shortcuts stay with the app, so copy/paste keep working).
 */
export function keyToInput(event: KeyLike): string | null {
  if (event.metaKey) return null;
  if (event.ctrlKey && !event.altKey) {
    if (/^[a-zA-Z]$/.test(event.key)) return String.fromCharCode(event.key.toLowerCase().charCodeAt(0) - 96);
    if (event.key === "[") return ESC;
    if (event.key === "\\") return String.fromCharCode(0x1c);
    if (event.key === "]") return String.fromCharCode(0x1d);
    return null;
  }
  if (event.shiftKey && event.key === "Tab") return `${ESC}[Z`;
  const named = NAMED[event.key];
  if (named !== undefined) return event.altKey ? `${ESC}${named}` : named;
  if (Array.from(event.key).length === 1) return event.altKey ? `${ESC}${event.key}` : event.key;
  return null;
}

/** Text pasted into the terminal: newlines become Enter presses. */
export function pasteToInput(text: string): string {
  return text.replace(/\r?\n/g, "\r");
}
