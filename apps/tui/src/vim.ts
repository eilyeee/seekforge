/**
 * Pure vim-mode state machine for the composer. applyVimKey interprets one
 * keystroke against a (VimState, EditorState) pair and returns the next
 * states plus a passthrough flag; the app keeps its normal handling
 * (insertion, history, submit) only for keys vim did not consume. Cursor
 * math reuses the pure ops from editor.ts.
 *
 * Register convention: a register value that STARTS WITH "\n" is LINEWISE —
 * the line content follows the marker (dd/yy/cc/S write it, and `p` pastes
 * it on a new line below the cursor). Charwise deletions (x/D/C/s/dw/cw)
 * never capture newlines, so the marker is unambiguous.
 *
 * Deliberate deviation: ctrl-modified keys in normal mode pass through so
 * global app shortcuts (ctrl+c quit, ctrl+g external editor, ...) keep
 * working even while the composer is in normal mode.
 */

import {
  deleteForward,
  moveDown,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveUp,
  snapToBoundary,
  type EditorState,
} from "./editor.js";

export type VimMode = "insert" | "normal";

export type VimState = {
  mode: VimMode;
  /** Pending operator ("d" | "c" | "y" | "g") awaiting a motion, if any. */
  pending?: string;
  /** Yank/delete register (leading "\n" marks a linewise value). */
  register: string;
  /** Undo stack of editor snapshots (cap 50). */
  undo: EditorState[];
};

/** Fresh vim state; the composer starts out in insert mode. */
export function initialVim(): VimState {
  return { mode: "insert", register: "", undo: [] };
}

export type VimKeyInput = {
  /** Printable char ("" for named keys). */
  input: string;
  name?: "escape" | "return" | "backspace" | "up" | "down" | "left" | "right" | "tab";
  ctrl?: boolean;
};

export type VimResult = {
  vim: VimState;
  editor: EditorState;
  /**
   * True when the key was NOT consumed by vim and the app should handle it
   * normally (history, submit, palette keys, plain insertion in insert mode…).
   */
  passthrough: boolean;
};

const MAX_UNDO = 50;

function consumed(vim: VimState, editor: EditorState): VimResult {
  return { vim, editor, passthrough: false };
}

function pass(vim: VimState, editor: EditorState): VimResult {
  return { vim, editor, passthrough: true };
}

/** VimState with the pending operator dropped (exactOptionalPropertyTypes). */
function clearPending(vim: VimState): VimState {
  return { mode: vim.mode, register: vim.register, undo: vim.undo };
}

/** Pushes an editor snapshot onto the undo stack, capped at MAX_UNDO. */
function pushUndo(vim: VimState, snapshot: EditorState): VimState {
  const undo =
    vim.undo.length >= MAX_UNDO
      ? [...vim.undo.slice(vim.undo.length - (MAX_UNDO - 1)), snapshot]
      : [...vim.undo, snapshot];
  return { ...vim, undo };
}

/**
 * Applies a mutation: snapshots `before` for undo when the text actually
 * changed, optionally writes the register and switches to insert mode.
 */
function mutate(
  vim: VimState,
  before: EditorState,
  after: EditorState,
  opts: { register?: string; insert?: boolean } = {},
): VimResult {
  let next = after.text !== before.text ? pushUndo(vim, before) : vim;
  if (opts.register !== undefined) next = { ...next, register: opts.register };
  if (opts.insert) next = { ...next, mode: "insert" };
  return consumed(next, after);
}

type CharClass = "space" | "word" | "punct";

function classOf(ch: string): CharClass {
  if (/\s/.test(ch)) return "space";
  if (/[A-Za-z0-9_]/.test(ch)) return "word";
  return "punct";
}

function charAt(text: string, pos: number): string {
  const cp = text.codePointAt(pos);
  return cp === undefined ? "" : String.fromCodePoint(cp);
}

function nextIndex(text: string, pos: number): number {
  return moveRight({ text, cursor: snapToBoundary(text, pos) }).cursor;
}

function prevIndex(text: string, pos: number): number {
  return moveLeft({ text, cursor: snapToBoundary(text, pos) }).cursor;
}

/** Start of the next vim word ("w"): skip the current run, then whitespace. */
function nextWordStart(text: string, pos: number): number {
  const len = text.length;
  let i = snapToBoundary(text, pos);
  if (i >= len) return len;
  const cls = classOf(charAt(text, i));
  if (cls !== "space") {
    while (i < len && classOf(charAt(text, i)) === cls) i = nextIndex(text, i);
  }
  while (i < len && classOf(charAt(text, i)) === "space") i = nextIndex(text, i);
  return i;
}

/** Start of the previous vim word ("b"). */
function prevWordStart(text: string, pos: number): number {
  let i = snapToBoundary(text, pos);
  while (i > 0 && classOf(charAt(text, prevIndex(text, i))) === "space") i = prevIndex(text, i);
  if (i === 0) return 0;
  const cls = classOf(charAt(text, prevIndex(text, i)));
  while (i > 0 && classOf(charAt(text, prevIndex(text, i))) === cls) i = prevIndex(text, i);
  return i;
}

/** Index of the last char of the current/next word ("e"). */
function wordEnd(text: string, pos: number): number {
  const len = text.length;
  let i = nextIndex(text, pos);
  while (i < len && classOf(charAt(text, i)) === "space") i = nextIndex(text, i);
  if (i >= len) return pos;
  const cls = classOf(charAt(text, i));
  let next = nextIndex(text, i);
  while (next < len && classOf(charAt(text, next)) === cls) {
    i = next;
    next = nextIndex(text, i);
  }
  return i;
}

/** End index (exclusive) of the run of same-class chars starting at `pos`. */
function runEnd(text: string, pos: number): number {
  const len = text.length;
  const cls = classOf(charAt(text, pos));
  let i = snapToBoundary(text, pos);
  while (i < len && classOf(charAt(text, i)) === cls) i = nextIndex(text, i);
  return i;
}

/** Deletes the whole current line including its newline ("dd"). */
function deleteLine(vim: VimState, editor: EditorState): VimResult {
  const { text } = editor;
  const ls = moveHome(editor).cursor;
  const le = moveEnd(editor).cursor;
  const register = "\n" + text.slice(ls, le);
  const newText =
    le < text.length
      ? text.slice(0, ls) + text.slice(le + 1)
      : text.slice(0, Math.max(0, ls - 1));
  const landing = Math.min(ls, newText.length);
  const cursor = moveHome({ text: newText, cursor: landing }).cursor;
  return mutate(vim, editor, { text: newText, cursor }, { register });
}

/** Clears the current line's content keeping the line ("cc"/"S") → insert. */
function changeLine(vim: VimState, editor: EditorState): VimResult {
  const ls = moveHome(editor).cursor;
  const le = moveEnd(editor).cursor;
  const content = editor.text.slice(ls, le);
  const after = { text: editor.text.slice(0, ls) + editor.text.slice(le), cursor: ls };
  return mutate(vim, editor, after, { register: "\n" + content, insert: true });
}

/** Deletes from the cursor to the next word start, clamped to line end ("dw"). */
function deleteWord(vim: VimState, editor: EditorState): VimResult {
  const le = moveEnd(editor).cursor;
  const target = Math.min(nextWordStart(editor.text, editor.cursor), le);
  const removed = editor.text.slice(editor.cursor, target);
  if (removed === "") return consumed(vim, editor);
  const after = {
    text: editor.text.slice(0, editor.cursor) + editor.text.slice(target),
    cursor: editor.cursor,
  };
  return mutate(vim, editor, after, { register: removed });
}

/** Changes to the end of the current word (vim's cw ≈ ce) → insert. */
function changeWord(vim: VimState, editor: EditorState): VimResult {
  const { text, cursor } = editor;
  const onWord = cursor < text.length && classOf(charAt(text, cursor)) !== "space";
  const le = moveEnd(editor).cursor;
  const target = onWord ? runEnd(text, cursor) : Math.min(nextWordStart(text, cursor), le);
  const removed = text.slice(cursor, target);
  const after = { text: text.slice(0, cursor) + text.slice(target), cursor };
  return mutate(vim, editor, after, {
    ...(removed === "" ? {} : { register: removed }),
    insert: true,
  });
}

/** Deletes from the cursor to line end ("D"); `insert` makes it "C". */
function deleteToLineEnd(vim: VimState, editor: EditorState, insert: boolean): VimResult {
  const le = moveEnd(editor).cursor;
  const removed = editor.text.slice(editor.cursor, le);
  const after = {
    text: editor.text.slice(0, editor.cursor) + editor.text.slice(le),
    cursor: editor.cursor,
  };
  return mutate(vim, editor, after, {
    ...(removed === "" ? {} : { register: removed }),
    ...(insert ? { insert: true } : {}),
  });
}

/** Deletes the char under the cursor ("x"); `insert` makes it "s". */
function deleteChar(vim: VimState, editor: EditorState, insert: boolean): VimResult {
  // codePointAt (not text[cursor]) so an astral char (emoji) yields the whole
  // character in the register, matching what deleteForward removes — otherwise
  // `x` then `p` would re-insert a lone surrogate and corrupt the buffer.
  const cp = editor.text.codePointAt(editor.cursor);
  const ch = cp === undefined ? undefined : String.fromCodePoint(cp);
  const removable = ch !== undefined && ch !== "\n";
  return mutate(vim, editor, removable ? deleteForward(editor) : editor, {
    ...(removable ? { register: ch } : {}),
    ...(insert ? { insert: true } : {}),
  });
}

/** Pastes the register after the cursor (charwise) or on a new line (linewise). */
function paste(vim: VimState, editor: EditorState): VimResult {
  const { register } = vim;
  if (register === "") return consumed(vim, editor);
  const { text, cursor } = editor;
  if (register.startsWith("\n")) {
    const content = register.slice(1);
    const le = moveEnd(editor).cursor;
    const after = {
      text: text.slice(0, le) + "\n" + content + text.slice(le),
      cursor: le + 1,
    };
    return mutate(vim, editor, after);
  }
  // Insert AFTER the character under the cursor. Advance by a whole code point
  // (surrogate-aware) so an astral char isn't split, and snap the landing cursor
  // back onto a code-point boundary.
  const pos = cursor < text.length && text[cursor] !== "\n" ? moveRight({ text, cursor }).cursor : cursor;
  const newText = text.slice(0, pos) + register + text.slice(pos);
  const after = {
    text: newText,
    cursor: snapToBoundary(newText, Math.max(pos, pos + register.length - 1)),
  };
  return mutate(vim, editor, after);
}

/** Resolves the second key of an operator-pending sequence (dd, dw, cw, …). */
function resolvePending(vim: VimState, editor: EditorState, key: VimKeyInput): VimResult {
  const base = clearPending(vim);
  const next = key.name === undefined ? key.input : "";
  const sequence = vim.pending + next;
  switch (sequence) {
    case "gg":
      return consumed(base, { text: editor.text, cursor: 0 });
    case "dd":
      return deleteLine(base, editor);
    case "dw":
      return deleteWord(base, editor);
    case "cc":
      return changeLine(base, editor);
    case "cw":
      return changeWord(base, editor);
    case "yy":
      return consumed(
        { ...base, register: "\n" + editor.text.slice(moveHome(editor).cursor, moveEnd(editor).cursor) },
        editor,
      );
    default:
      // Unrecognized follow-up: clear pending and ignore the key.
      return consumed(base, editor);
  }
}

function applyNormalKey(vim: VimState, editor: EditorState, key: VimKeyInput): VimResult {
  if (vim.pending !== undefined) return resolvePending(vim, editor, key);
  // Keep global app shortcuts (ctrl+c, ctrl+g, …) alive in normal mode.
  if (key.ctrl) return pass(vim, editor);
  switch (key.name) {
    case "return": // Enter still submits.
    case "up": // History recall.
    case "down":
      return pass(vim, editor);
    case "left":
      return consumed(vim, moveLeft(editor));
    case "right":
      return consumed(vim, moveRight(editor));
    case "backspace":
      return consumed(vim, moveLeft(editor));
    case "escape":
    case "tab":
      return consumed(vim, editor);
    default:
      break;
  }
  switch (key.input) {
    // Motions.
    case "h":
      return consumed(vim, moveLeft(editor));
    case "l":
      return consumed(vim, moveRight(editor));
    case "j":
      return consumed(vim, moveDown(editor));
    case "k":
      return consumed(vim, moveUp(editor));
    case "0":
      return consumed(vim, moveHome(editor));
    case "$":
      return consumed(vim, moveEnd(editor));
    case "w":
      return consumed(vim, { text: editor.text, cursor: nextWordStart(editor.text, editor.cursor) });
    case "b":
      return consumed(vim, { text: editor.text, cursor: prevWordStart(editor.text, editor.cursor) });
    case "e":
      return consumed(vim, { text: editor.text, cursor: wordEnd(editor.text, editor.cursor) });
    case "G":
      return consumed(vim, { text: editor.text, cursor: editor.text.length });
    // Operators (pending).
    case "d":
    case "c":
    case "y":
    case "g":
      return consumed({ ...vim, pending: key.input }, editor);
    // Enter insert mode.
    case "i":
      return consumed({ ...vim, mode: "insert" }, editor);
    case "a":
      return consumed({ ...vim, mode: "insert" }, moveRight(editor));
    case "I":
      return consumed({ ...vim, mode: "insert" }, moveHome(editor));
    case "A":
      return consumed({ ...vim, mode: "insert" }, moveEnd(editor));
    case "o": {
      const le = moveEnd(editor).cursor;
      const after = { text: editor.text.slice(0, le) + "\n" + editor.text.slice(le), cursor: le + 1 };
      return mutate(vim, editor, after, { insert: true });
    }
    case "O": {
      const ls = moveHome(editor).cursor;
      const after = { text: editor.text.slice(0, ls) + "\n" + editor.text.slice(ls), cursor: ls };
      return mutate(vim, editor, after, { insert: true });
    }
    // Edits.
    case "x":
      return deleteChar(vim, editor, false);
    case "s":
      return deleteChar(vim, editor, true);
    case "D":
      return deleteToLineEnd(vim, editor, false);
    case "C":
      return deleteToLineEnd(vim, editor, true);
    case "S":
      return changeLine(vim, editor);
    case "p":
      return paste(vim, editor);
    case "u": {
      const prev = vim.undo[vim.undo.length - 1];
      if (prev === undefined) return consumed(vim, editor);
      return consumed({ ...vim, undo: vim.undo.slice(0, -1) }, prev);
    }
    default:
      // Unknown normal-mode keys are consumed as no-ops.
      return consumed(vim, editor);
  }
}

/**
 * Interprets one keystroke. Insert mode only intercepts Escape (→ normal
 * mode, cursor one left clamped to line start); everything else passes
 * through. Normal mode consumes all keys except return/up/down (and
 * ctrl-modified keys, see header).
 */
export function applyVimKey(vim: VimState, editor: EditorState, key: VimKeyInput): VimResult {
  if (vim.mode === "insert") {
    if (key.name === "escape" && key.ctrl !== true) {
      const ls = moveHome(editor).cursor;
      // Step one whole code point left (surrogate-aware), clamped to line start —
      // a bare cursor-1 lands between the halves of an astral char (emoji).
      const cursor = Math.max(ls, moveLeft(editor).cursor);
      return consumed({ ...vim, mode: "normal" }, { text: editor.text, cursor });
    }
    return pass(vim, editor);
  }
  return applyNormalKey(vim, editor, key);
}
