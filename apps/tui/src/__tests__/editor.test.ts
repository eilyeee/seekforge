import { describe, expect, it } from "vitest";
import {
  atTokenAt,
  backspace,
  clearAll,
  deleteForward,
  emptyEditor,
  endsWithContinuation,
  insertText,
  isOnFirstLine,
  isOnLastLine,
  moveDown,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveUp,
  replaceAtToken,
  setText,
  slashPrefix,
  type EditorState,
} from "../editor.js";

function at(text: string, cursor: number): EditorState {
  return { text, cursor };
}

describe("insertText", () => {
  it("inserts at the cursor and advances it", () => {
    const s = insertText(at("ace", 1), "b");
    expect(s).toEqual({ text: "abce", cursor: 2 });
  });

  it("normalizes \\r\\n and \\r to \\n (paste support)", () => {
    const s = insertText(emptyEditor(), "one\r\ntwo\rthree");
    expect(s.text).toBe("one\ntwo\nthree");
    expect(s.cursor).toBe(s.text.length);
  });
});

describe("backspace / deleteForward", () => {
  it("backspace removes the char before the cursor", () => {
    expect(backspace(at("abc", 2))).toEqual({ text: "ac", cursor: 1 });
  });
  it("backspace at 0 is a no-op", () => {
    expect(backspace(at("abc", 0))).toEqual({ text: "abc", cursor: 0 });
  });
  it("deleteForward removes the char at the cursor", () => {
    expect(deleteForward(at("abc", 1))).toEqual({ text: "ac", cursor: 1 });
  });
  it("deleteForward at the end is a no-op", () => {
    expect(deleteForward(at("abc", 3))).toEqual({ text: "abc", cursor: 3 });
  });
});

describe("horizontal movement", () => {
  it("moveLeft/moveRight clamp at the edges", () => {
    expect(moveLeft(at("ab", 0)).cursor).toBe(0);
    expect(moveLeft(at("ab", 2)).cursor).toBe(1);
    expect(moveRight(at("ab", 2)).cursor).toBe(2);
    expect(moveRight(at("ab", 0)).cursor).toBe(1);
  });

  it("moveHome/moveEnd go to the current line's bounds", () => {
    const s = at("first\nsecond", 8); // inside "second"
    expect(moveHome(s).cursor).toBe(6);
    expect(moveEnd(s).cursor).toBe(12);
  });
});

describe("vertical movement", () => {
  it("moveUp keeps the column", () => {
    const s = at("alpha\nbeta", 8); // col 2 in "beta"
    expect(moveUp(s).cursor).toBe(2);
  });

  it("moveUp clamps to the previous line's length", () => {
    const s = at("ab\nlonger", 9); // col 6 in "longer"
    expect(moveUp(s).cursor).toBe(2); // end of "ab"
  });

  it("moveUp on the first line is a no-op", () => {
    expect(moveUp(at("abc\ndef", 2)).cursor).toBe(2);
  });

  it("moveDown keeps the column and clamps", () => {
    expect(moveDown(at("alpha\nbeta", 2)).cursor).toBe(8);
    expect(moveDown(at("longer\nab", 5)).cursor).toBe(9); // clamped to end of "ab"
  });

  it("moveDown on the last line is a no-op", () => {
    expect(moveDown(at("abc\ndef", 5)).cursor).toBe(5);
  });
});

describe("buffer ops & line predicates", () => {
  it("clearAll empties the buffer", () => {
    expect(clearAll(at("hello", 3))).toEqual({ text: "", cursor: 0 });
  });

  it("setText puts the cursor at the end", () => {
    expect(setText("ab\ncd")).toEqual({ text: "ab\ncd", cursor: 5 });
  });

  it("isOnFirstLine / isOnLastLine", () => {
    expect(isOnFirstLine(at("ab\ncd", 1))).toBe(true);
    expect(isOnFirstLine(at("ab\ncd", 4))).toBe(false);
    expect(isOnLastLine(at("ab\ncd", 4))).toBe(true);
    expect(isOnLastLine(at("ab\ncd", 1))).toBe(false);
    expect(isOnFirstLine(at("single", 3))).toBe(true);
    expect(isOnLastLine(at("single", 3))).toBe(true);
  });
});

describe("endsWithContinuation", () => {
  it("true when the text before the cursor ends with a backslash", () => {
    expect(endsWithContinuation(at("line\\", 5))).toBe(true);
  });
  it("false otherwise and when the backslash is after the cursor", () => {
    expect(endsWithContinuation(at("line", 4))).toBe(false);
    expect(endsWithContinuation(at("line\\", 4))).toBe(false);
  });
});

describe("atTokenAt", () => {
  it("finds the token immediately before the cursor", () => {
    expect(atTokenAt(at("see @src/mod", 12))).toEqual({ anchor: 4, query: "src/mod" });
  });

  it("finds a token the cursor is inside (query is token-so-far)", () => {
    expect(atTokenAt(at("see @src/mod end", 9))).toEqual({ anchor: 4, query: "src/" });
  });

  it("returns an empty query right after @", () => {
    expect(atTokenAt(at("@", 1))).toEqual({ anchor: 0, query: "" });
  });

  it("does not trigger on emails (@ not preceded by whitespace)", () => {
    expect(atTokenAt(at("mail a@b.com", 12))).toBeNull();
  });

  it("triggers at text start and after whitespace only", () => {
    expect(atTokenAt(at("@file", 5))).toEqual({ anchor: 0, query: "file" });
    expect(atTokenAt(at("x @file", 7))).toEqual({ anchor: 2, query: "file" });
  });

  it("null when there is no @ token", () => {
    expect(atTokenAt(at("plain text", 5))).toBeNull();
  });
});

describe("slashPrefix", () => {
  it("returns the command name typed so far", () => {
    expect(slashPrefix(at("/mod", 4))).toBe("mod");
    expect(slashPrefix(at("/", 1))).toBe("");
  });

  it("only while the cursor is within the first word", () => {
    expect(slashPrefix(at("/plan do it", 3))).toBe("pl");
    expect(slashPrefix(at("/plan do it", 8))).toBeNull();
  });

  it("null for non-slash, multiline, or cursor before the slash", () => {
    expect(slashPrefix(at("plan", 2))).toBeNull();
    expect(slashPrefix(at("/a\nb", 2))).toBeNull();
    expect(slashPrefix(at("/abc", 0))).toBeNull();
  });
});

describe("replaceAtToken", () => {
  it("replaces the token and lands the cursor after the inserted space", () => {
    const s = replaceAtToken(at("see @src/mo end", 11), 4, "src/model.ts");
    expect(s.text).toBe("see @src/model.ts  end");
    expect(s.cursor).toBe(4 + "@src/model.ts ".length);
  });

  it("works with an empty token at the end of the buffer", () => {
    const s = replaceAtToken(at("look @", 6), 5, "a.txt");
    expect(s.text).toBe("look @a.txt ");
    expect(s.cursor).toBe(12);
  });
});
