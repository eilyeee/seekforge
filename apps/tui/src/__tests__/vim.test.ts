import { describe, expect, it } from "vitest";
import type { EditorState } from "../editor.js";
import { applyVimKey, initialVim, type VimKeyInput, type VimState } from "../vim.js";

function at(text: string, cursor: number): EditorState {
  return { text, cursor };
}

function normal(overrides: Partial<VimState> = {}): VimState {
  return { ...initialVim(), mode: "normal", ...overrides };
}

function ch(input: string): VimKeyInput {
  return { input };
}

/** Feeds a sequence of keys, threading vim + editor state through. */
function feed(vim: VimState, editor: EditorState, keys: VimKeyInput[]) {
  let result = { vim, editor, passthrough: false };
  for (const key of keys) result = applyVimKey(result.vim, result.editor, key);
  return result;
}

describe("initialVim", () => {
  it("starts in insert mode with an empty register and undo stack", () => {
    expect(initialVim()).toEqual({ mode: "insert", register: "", undo: [] });
  });
});

describe("insert mode", () => {
  it("Escape enters normal mode and moves the cursor one left", () => {
    const r = applyVimKey(initialVim(), at("abc", 3), { input: "", name: "escape" });
    expect(r.passthrough).toBe(false);
    expect(r.vim.mode).toBe("normal");
    expect(r.editor).toEqual(at("abc", 2));
  });

  it("Escape clamps the cursor-left to the line start", () => {
    const r = applyVimKey(initialVim(), at("ab\ncd", 3), { input: "", name: "escape" });
    expect(r.vim.mode).toBe("normal");
    expect(r.editor.cursor).toBe(3);
  });

  it("passes printable characters through unchanged", () => {
    const vim = initialVim();
    const editor = at("abc", 1);
    const r = applyVimKey(vim, editor, ch("x"));
    expect(r).toEqual({ vim, editor, passthrough: true });
  });

  it("passes return and backspace through (submit / delete stay app-handled)", () => {
    const vim = initialVim();
    expect(applyVimKey(vim, at("a", 1), { input: "", name: "return" }).passthrough).toBe(true);
    expect(applyVimKey(vim, at("a", 1), { input: "", name: "backspace" }).passthrough).toBe(true);
  });
});

describe("normal mode motions", () => {
  it("h/l move left/right with clamping", () => {
    expect(applyVimKey(normal(), at("ab", 1), ch("h")).editor.cursor).toBe(0);
    expect(applyVimKey(normal(), at("ab", 0), ch("h")).editor.cursor).toBe(0);
    expect(applyVimKey(normal(), at("ab", 1), ch("l")).editor.cursor).toBe(2);
  });

  it("j/k move down/up keeping the column", () => {
    expect(applyVimKey(normal(), at("one\ntwo", 1), ch("j")).editor.cursor).toBe(5);
    expect(applyVimKey(normal(), at("one\ntwo", 5), ch("k")).editor.cursor).toBe(1);
  });

  it("0 and $ jump to line start and end", () => {
    expect(applyVimKey(normal(), at("one\ntwo", 6), ch("0")).editor.cursor).toBe(4);
    expect(applyVimKey(normal(), at("one\ntwo", 4), ch("$")).editor.cursor).toBe(7);
  });

  it("w steps through words and punctuation runs", () => {
    const text = "foo.bar baz";
    expect(applyVimKey(normal(), at(text, 0), ch("w")).editor.cursor).toBe(3); // "."
    expect(applyVimKey(normal(), at(text, 3), ch("w")).editor.cursor).toBe(4); // "bar"
    expect(applyVimKey(normal(), at(text, 4), ch("w")).editor.cursor).toBe(8); // "baz"
  });

  it("w crosses line boundaries and clamps at buffer end", () => {
    expect(applyVimKey(normal(), at("foo\nbar", 0), ch("w")).editor.cursor).toBe(4);
    expect(applyVimKey(normal(), at("foo", 0), ch("w")).editor.cursor).toBe(3);
  });

  it("b steps back through words, punctuation, and line boundaries", () => {
    expect(applyVimKey(normal(), at("foo bar", 4), ch("b")).editor.cursor).toBe(0);
    expect(applyVimKey(normal(), at("foo.bar", 4), ch("b")).editor.cursor).toBe(3);
    expect(applyVimKey(normal(), at("foo\nbar", 4), ch("b")).editor.cursor).toBe(0);
  });

  it("e lands on the last char of the current/next word", () => {
    expect(applyVimKey(normal(), at("foo bar", 0), ch("e")).editor.cursor).toBe(2);
    expect(applyVimKey(normal(), at("foo bar", 2), ch("e")).editor.cursor).toBe(6);
    expect(applyVimKey(normal(), at("foo.bar", 2), ch("e")).editor.cursor).toBe(3); // punct run
  });

  it("gg jumps to buffer start via pending g; G jumps to buffer end", () => {
    const r = feed(normal(), at("one\ntwo", 6), [ch("g"), ch("g")]);
    expect(r.editor.cursor).toBe(0);
    expect(r.vim.pending).toBeUndefined();
    expect(applyVimKey(normal(), at("one\ntwo", 0), ch("G")).editor.cursor).toBe(7);
  });
});

describe("entering insert mode", () => {
  it("i keeps the cursor; a moves one right (clamped)", () => {
    const i = applyVimKey(normal(), at("abc", 1), ch("i"));
    expect(i.vim.mode).toBe("insert");
    expect(i.editor.cursor).toBe(1);
    expect(applyVimKey(normal(), at("abc", 1), ch("a")).editor.cursor).toBe(2);
    expect(applyVimKey(normal(), at("abc", 3), ch("a")).editor.cursor).toBe(3);
  });

  it("I goes to line start; A goes to line end", () => {
    const big = applyVimKey(normal(), at("one\ntwo", 6), ch("I"));
    expect(big.vim.mode).toBe("insert");
    expect(big.editor.cursor).toBe(4);
    const a = applyVimKey(normal(), at("one\ntwo", 1), ch("A"));
    expect(a.vim.mode).toBe("insert");
    expect(a.editor.cursor).toBe(3);
  });

  it("o opens a line below; O opens a line above", () => {
    const o = applyVimKey(normal(), at("one\ntwo", 1), ch("o"));
    expect(o.vim.mode).toBe("insert");
    expect(o.editor).toEqual(at("one\n\ntwo", 4));
    const big = applyVimKey(normal(), at("one\ntwo", 5), ch("O"));
    expect(big.vim.mode).toBe("insert");
    expect(big.editor).toEqual(at("one\n\ntwo", 4));
  });
});

describe("edits and register", () => {
  it("x deletes the char under the cursor into the register (charwise)", () => {
    const r = applyVimKey(normal(), at("abc", 0), ch("x"));
    expect(r.editor).toEqual(at("bc", 0));
    expect(r.vim.register).toBe("a");
    expect(r.vim.mode).toBe("normal");
  });

  it("x at buffer end is a no-op and leaves the register alone", () => {
    const r = applyVimKey(normal({ register: "z" }), at("", 0), ch("x"));
    expect(r.editor).toEqual(at("", 0));
    expect(r.vim.register).toBe("z");
    expect(r.vim.undo).toHaveLength(0);
  });

  it("x then p pastes charwise after the cursor", () => {
    const r = feed(normal(), at("abc", 0), [ch("x"), ch("p")]);
    expect(r.editor).toEqual(at("bac", 1));
  });

  it("dd deletes the line into a linewise register and lands at the next line start", () => {
    const r = feed(normal(), at("one\ntwo\nthree", 5), [ch("d"), ch("d")]);
    expect(r.editor).toEqual(at("one\nthree", 4));
    expect(r.vim.register).toBe("\ntwo");
  });

  it("dd on the last line removes the preceding newline", () => {
    const r = feed(normal(), at("one\ntwo", 5), [ch("d"), ch("d")]);
    expect(r.editor).toEqual(at("one", 0));
    expect(r.vim.register).toBe("\ntwo");
  });

  it("dd then p pastes the line back below the cursor (linewise)", () => {
    const r = feed(normal(), at("one\ntwo\nthree", 5), [ch("d"), ch("d"), ch("p")]);
    expect(r.editor).toEqual(at("one\nthree\ntwo", 10));
  });

  it("yy yanks the line without mutating and p pastes it below", () => {
    const r = feed(normal(), at("one\ntwo", 0), [ch("y"), ch("y")]);
    expect(r.editor).toEqual(at("one\ntwo", 0));
    expect(r.vim.register).toBe("\none");
    expect(r.vim.undo).toHaveLength(0);
    const p = applyVimKey(r.vim, r.editor, ch("p"));
    expect(p.editor).toEqual(at("one\none\ntwo", 4));
  });

  it("p with an empty register is a no-op", () => {
    const r = applyVimKey(normal(), at("abc", 0), ch("p"));
    expect(r.editor).toEqual(at("abc", 0));
    expect(r.vim.undo).toHaveLength(0);
  });

  it("dw deletes to the next word start including trailing spaces", () => {
    const r = feed(normal(), at("foo bar", 0), [ch("d"), ch("w")]);
    expect(r.editor).toEqual(at("bar", 0));
    expect(r.vim.register).toBe("foo ");
  });

  it("dw on the last word of a line stops at the line end", () => {
    const r = feed(normal(), at("foo bar\nbaz", 4), [ch("d"), ch("w")]);
    expect(r.editor).toEqual(at("foo \nbaz", 4));
    expect(r.vim.register).toBe("bar");
  });

  it("cw changes to the end of the current word and enters insert", () => {
    const r = feed(normal(), at("foo bar", 0), [ch("c"), ch("w")]);
    expect(r.editor).toEqual(at(" bar", 0));
    expect(r.vim.register).toBe("foo");
    expect(r.vim.mode).toBe("insert");
  });

  it("cc and S clear the line content, keep the line, and enter insert", () => {
    const cc = feed(normal(), at("one\ntwo", 1), [ch("c"), ch("c")]);
    expect(cc.editor).toEqual(at("\ntwo", 0));
    expect(cc.vim.register).toBe("\none");
    expect(cc.vim.mode).toBe("insert");
    const s = applyVimKey(normal(), at("one\ntwo", 1), ch("S"));
    expect(s.editor).toEqual(at("\ntwo", 0));
    expect(s.vim.mode).toBe("insert");
  });

  it("D deletes to line end; C does the same and enters insert", () => {
    const d = applyVimKey(normal(), at("foo bar\nbaz", 3), ch("D"));
    expect(d.editor).toEqual(at("foo\nbaz", 3));
    expect(d.vim.register).toBe(" bar");
    expect(d.vim.mode).toBe("normal");
    const c = applyVimKey(normal(), at("foo bar", 3), ch("C"));
    expect(c.editor).toEqual(at("foo", 3));
    expect(c.vim.mode).toBe("insert");
  });

  it("s substitutes the char under the cursor and enters insert", () => {
    const r = applyVimKey(normal(), at("abc", 1), ch("s"));
    expect(r.editor).toEqual(at("ac", 1));
    expect(r.vim.register).toBe("b");
    expect(r.vim.mode).toBe("insert");
  });
});

describe("undo", () => {
  it("u round-trips a dd", () => {
    const before = at("one\ntwo", 5);
    const r = feed(normal(), before, [ch("d"), ch("d"), ch("u")]);
    expect(r.editor).toEqual(before);
    expect(r.vim.undo).toHaveLength(0);
  });

  it("u with an empty stack is a no-op", () => {
    const r = applyVimKey(normal(), at("abc", 1), ch("u"));
    expect(r.editor).toEqual(at("abc", 1));
    expect(r.passthrough).toBe(false);
  });

  it("the undo stack is capped at 50 snapshots", () => {
    const keys = Array.from({ length: 60 }, () => ch("x"));
    const r = feed(normal(), at("a".repeat(60), 0), keys);
    expect(r.vim.undo).toHaveLength(50);
    expect(r.editor.text).toBe("");
  });
});

describe("operator pending", () => {
  it("d sets pending and the key is consumed", () => {
    const r = applyVimKey(normal(), at("abc", 0), ch("d"));
    expect(r.vim.pending).toBe("d");
    expect(r.passthrough).toBe(false);
    expect(r.editor).toEqual(at("abc", 0));
  });

  it("an unrecognized follow-up clears pending and is ignored", () => {
    const r = feed(normal(), at("abc", 0), [ch("d"), ch("z")]);
    expect(r.vim.pending).toBeUndefined();
    expect(r.editor).toEqual(at("abc", 0));
    expect(r.passthrough).toBe(false);
  });

  it("escape during pending clears it without side effects", () => {
    const r = feed(normal(), at("abc", 0), [ch("c"), { input: "", name: "escape" }]);
    expect(r.vim.pending).toBeUndefined();
    expect(r.vim.mode).toBe("normal");
    expect(r.editor).toEqual(at("abc", 0));
  });
});

describe("passthrough rules in normal mode", () => {
  it("return passes through so Enter still submits", () => {
    const r = applyVimKey(normal(), at("abc", 1), { input: "", name: "return" });
    expect(r.passthrough).toBe(true);
    expect(r.editor).toEqual(at("abc", 1));
  });

  it("up/down arrows pass through for history", () => {
    expect(applyVimKey(normal(), at("a", 0), { input: "", name: "up" }).passthrough).toBe(true);
    expect(applyVimKey(normal(), at("a", 0), { input: "", name: "down" }).passthrough).toBe(true);
  });

  it("left/right arrows are consumed and move the cursor", () => {
    const r = applyVimKey(normal(), at("ab", 1), { input: "", name: "left" });
    expect(r.passthrough).toBe(false);
    expect(r.editor.cursor).toBe(0);
  });

  it("ctrl-modified keys pass through (global shortcuts keep working)", () => {
    const r = applyVimKey(normal(), at("abc", 1), { input: "c", ctrl: true });
    expect(r.passthrough).toBe(true);
    expect(r.editor).toEqual(at("abc", 1));
  });

  it("unknown printable keys are consumed as no-ops", () => {
    const r = applyVimKey(normal(), at("abc", 1), ch("q"));
    expect(r.passthrough).toBe(false);
    expect(r.editor).toEqual(at("abc", 1));
    expect(r.vim).toEqual(normal());
  });
});
