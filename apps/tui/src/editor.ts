/**
 * Pure multiline editor model for the composer. The cursor is a code-unit
 * index into the text, so every operation is a plain string splice and the
 * whole model stays trivially unit-testable — the Ink component only renders
 * an EditorState, and app.tsx maps keystrokes to these functions.
 */

export type EditorState = { text: string; cursor: number };

export function emptyEditor(): EditorState {
  return { text: "", cursor: 0 };
}

/** Start index of the line containing `pos`. */
function lineStart(text: string, pos: number): number {
  return text.lastIndexOf("\n", pos - 1) + 1;
}

/** End index (exclusive, before "\n") of the line containing `pos`. */
function lineEnd(text: string, pos: number): number {
  const idx = text.indexOf("\n", pos);
  return idx === -1 ? text.length : idx;
}

/** Insert text at the cursor; \r\n and \r are normalized to \n (paste). */
export function insertText(s: EditorState, input: string): EditorState {
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return {
    text: s.text.slice(0, s.cursor) + normalized + s.text.slice(s.cursor),
    cursor: s.cursor + normalized.length,
  };
}

export function backspace(s: EditorState): EditorState {
  if (s.cursor === 0) return s;
  return {
    text: s.text.slice(0, s.cursor - 1) + s.text.slice(s.cursor),
    cursor: s.cursor - 1,
  };
}

export function deleteForward(s: EditorState): EditorState {
  if (s.cursor >= s.text.length) return s;
  return {
    text: s.text.slice(0, s.cursor) + s.text.slice(s.cursor + 1),
    cursor: s.cursor,
  };
}

export function moveLeft(s: EditorState): EditorState {
  return { text: s.text, cursor: Math.max(0, s.cursor - 1) };
}

export function moveRight(s: EditorState): EditorState {
  return { text: s.text, cursor: Math.min(s.text.length, s.cursor + 1) };
}

/** Same column on the previous line, clamped to that line's length. */
export function moveUp(s: EditorState): EditorState {
  const start = lineStart(s.text, s.cursor);
  if (start === 0) return s; // already on the first line
  const column = s.cursor - start;
  const prevStart = lineStart(s.text, start - 1);
  const prevLength = start - 1 - prevStart;
  return { text: s.text, cursor: prevStart + Math.min(column, prevLength) };
}

/** Same column on the next line, clamped to that line's length. */
export function moveDown(s: EditorState): EditorState {
  const end = lineEnd(s.text, s.cursor);
  if (end === s.text.length) return s; // already on the last line
  const column = s.cursor - lineStart(s.text, s.cursor);
  const nextStart = end + 1;
  const nextLength = lineEnd(s.text, nextStart) - nextStart;
  return { text: s.text, cursor: nextStart + Math.min(column, nextLength) };
}

export function moveHome(s: EditorState): EditorState {
  return { text: s.text, cursor: lineStart(s.text, s.cursor) };
}

export function moveEnd(s: EditorState): EditorState {
  return { text: s.text, cursor: lineEnd(s.text, s.cursor) };
}

export function clearAll(_s: EditorState): EditorState {
  return emptyEditor();
}

/** Replace the whole buffer; cursor lands at the end (history recall). */
export function setText(text: string): EditorState {
  return { text, cursor: text.length };
}

export function isOnFirstLine(s: EditorState): boolean {
  return lineStart(s.text, s.cursor) === 0;
}

export function isOnLastLine(s: EditorState): boolean {
  return lineEnd(s.text, s.cursor) === s.text.length;
}

/**
 * Trailing-backslash continuation: true when the text before the cursor ends
 * with "\" (submit then becomes newline instead of sending).
 */
export function endsWithContinuation(s: EditorState): boolean {
  return s.text.slice(0, s.cursor).endsWith("\\");
}

const TOKEN_CHAR = /[A-Za-z0-9_\-./]/;

/**
 * The "@token" containing or immediately before the cursor, or null. The "@"
 * must be at the start of the text or preceded by whitespace so emails like
 * a@b.com never trigger the file picker.
 */
export function atTokenAt(s: EditorState): { anchor: number; query: string } | null {
  let start = s.cursor;
  while (start > 0 && TOKEN_CHAR.test(s.text[start - 1] ?? "")) start -= 1;
  if (start === 0 || s.text[start - 1] !== "@") return null;
  const anchor = start - 1;
  if (anchor > 0 && !/\s/.test(s.text[anchor - 1] ?? "")) return null;
  return { anchor, query: s.text.slice(start, s.cursor) };
}

/**
 * When the buffer is a single line starting with "/" and the cursor sits
 * within the first word: the command name typed so far (without the slash,
 * possibly ""). Else null — the palette only opens for command-shaped input.
 */
export function slashPrefix(s: EditorState): string | null {
  if (s.text.includes("\n") || !s.text.startsWith("/")) return null;
  const wsIdx = s.text.search(/\s/);
  const firstWordEnd = wsIdx === -1 ? s.text.length : wsIdx;
  if (s.cursor < 1 || s.cursor > firstWordEnd) return null;
  return s.text.slice(1, s.cursor);
}

/**
 * Replace the @token starting at `anchor` with "@" + replacement + one
 * space; the cursor lands after the space (picker selection commit).
 */
export function replaceAtToken(s: EditorState, anchor: number, replacement: string): EditorState {
  let end = anchor + 1;
  while (end < s.text.length && TOKEN_CHAR.test(s.text[end] ?? "")) end += 1;
  const inserted = `@${replacement} `;
  return {
    text: s.text.slice(0, anchor) + inserted + s.text.slice(end),
    cursor: anchor + inserted.length,
  };
}

/**
 * Slash-command ARGUMENT context: when the buffer is a single line starting
 * with "/", the first word is complete (followed by whitespace), and the
 * cursor sits in/after the argument region, returns the command name
 * (lowercased, without the slash), the argument text from its start THROUGH
 * the cursor, and the index where the argument region begins (first char
 * after the whitespace run following the command word). Else null — while
 * the cursor is still inside the command word the name palette owns the
 * state, not the argument picker.
 */
export function slashArgAt(s: EditorState): { name: string; anchor: number; arg: string } | null {
  if (s.text.includes("\n") || !s.text.startsWith("/")) return null;
  const wsIdx = s.text.search(/\s/);
  if (wsIdx <= 1) return null; // no whitespace after the word, or an empty command name
  let anchor = wsIdx;
  while (anchor < s.text.length && /\s/.test(s.text[anchor] ?? "")) anchor += 1;
  if (s.cursor < anchor) return null;
  return {
    name: s.text.slice(1, wsIdx).toLowerCase(),
    anchor,
    arg: s.text.slice(anchor, s.cursor),
  };
}

/**
 * Replaces the argument region (`anchor` → end of line, so any text after
 * the cursor on that line is dropped — the simplest correct behavior for a
 * picker commit) with `replacement`; the cursor lands at the end of the
 * replacement. An empty replacement just truncates at the anchor.
 */
export function replaceSlashArg(s: EditorState, anchor: number, replacement: string): EditorState {
  const end = lineEnd(s.text, anchor);
  return {
    text: s.text.slice(0, anchor) + replacement + s.text.slice(end),
    cursor: anchor + replacement.length,
  };
}
