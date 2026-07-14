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
  replaceSlashArg,
  setText,
  slashArgAt,
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
  it("backspace deletes a whole astral char (surrogate pair) without corruption", () => {
    // "🎉" is 2 UTF-16 code units; cursor at 2 sits just after it.
    const s = backspace(at("🎉", 2));
    expect(s).toEqual({ text: "", cursor: 0 });
    // The result must be a valid string (no lone surrogate).
    expect(JSON.stringify(s.text)).toBe('""');
  });
  it("deleteForward deletes a whole astral char", () => {
    expect(deleteForward(at("🔥x", 0))).toEqual({ text: "x", cursor: 0 });
  });
  it.each(["e\u0301", "🇨🇳", "👍🏽", "👨‍👩‍👧‍👦"])("deletes the whole grapheme %s", (grapheme) => {
    expect(backspace(at(`${grapheme}x`, grapheme.length))).toEqual({ text: "x", cursor: 0 });
    expect(deleteForward(at(`${grapheme}x`, 0))).toEqual({ text: "x", cursor: 0 });
  });
});

describe("horizontal movement", () => {
  it("moveLeft/moveRight clamp at the edges", () => {
    expect(moveLeft(at("ab", 0)).cursor).toBe(0);
    expect(moveLeft(at("ab", 2)).cursor).toBe(1);
    expect(moveRight(at("ab", 2)).cursor).toBe(2);
    expect(moveRight(at("ab", 0)).cursor).toBe(1);
  });

  it.each(["e\u0301", "🇨🇳", "👍🏽", "👨‍👩‍👧‍👦"])("moves across the whole grapheme %s", (grapheme) => {
    expect(moveRight(at(`${grapheme}x`, 0)).cursor).toBe(grapheme.length);
    expect(moveLeft(at(`${grapheme}x`, grapheme.length)).cursor).toBe(0);
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

  it("keeps terminal display columns across CJK wide characters", () => {
    expect(moveDown(at("你a\n1234", 1)).cursor).toBe(5); // display column 2 -> after "12"
    expect(moveDown(at("ab\n你x", 2)).cursor).toBe(4); // display column 2 -> after "你"
    expect(moveUp(at("1234\n你a", 6)).cursor).toBe(2); // after "你" -> display column 2
  });

  it("treats combining sequences as one display cell and one cursor stop", () => {
    const combined = "e\u0301";
    expect(moveDown(at(`${combined}x\nabc`, combined.length)).cursor).toBe(combined.length + 3);
    expect(moveDown(at(`a\n${combined}x`, 1)).cursor).toBe(1 + 1 + combined.length);
    expect(moveUp(at(`a\n${combined}x`, 1 + 1 + combined.length)).cursor).toBe(1);
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

describe("slashArgAt", () => {
  it("returns the command name, anchor, and full argument at the end", () => {
    expect(slashArgAt(at("/resume 2026", 12))).toEqual({ name: "resume", anchor: 8, arg: "2026" });
  });

  it("the arg spans the whole region, not just the last word", () => {
    expect(slashArgAt(at("/todo done 2", 12))).toEqual({ name: "todo", anchor: 6, arg: "done 2" });
  });

  it("empty argument right after the separating space", () => {
    expect(slashArgAt(at("/resume ", 8))).toEqual({ name: "resume", anchor: 8, arg: "" });
  });

  it("null without a space — the command-name palette owns that state", () => {
    expect(slashArgAt(at("/resume", 7))).toBeNull();
  });

  it("cuts the argument at the cursor when mid-argument", () => {
    expect(slashArgAt(at("/resume 2026", 10))).toEqual({ name: "resume", anchor: 8, arg: "20" });
  });

  it("anchors after the whole whitespace run following the command word", () => {
    expect(slashArgAt(at("/todo   x", 9))).toEqual({ name: "todo", anchor: 8, arg: "x" });
  });

  it("works for a single-letter command", () => {
    expect(slashArgAt(at("/q ", 3))).toEqual({ name: "q", anchor: 3, arg: "" });
  });

  it("lowercases the command name", () => {
    expect(slashArgAt(at("/Resume 1", 9))).toEqual({ name: "resume", anchor: 8, arg: "1" });
  });

  it("null while the cursor is inside the command word or before the space", () => {
    expect(slashArgAt(at("/resume 2026", 3))).toBeNull();
    expect(slashArgAt(at("/plan x", 5))).toBeNull(); // on the separating space
  });

  it("null for multiline or non-slash input", () => {
    expect(slashArgAt(at("/a b\nc", 4))).toBeNull();
    expect(slashArgAt(at("todo x", 6))).toBeNull();
  });
});

describe("replaceSlashArg", () => {
  it("replaces the argument region through the end of the line", () => {
    const s = replaceSlashArg(at("/resume 20xx", 10), 8, "2026-06");
    expect(s.text).toBe("/resume 2026-06");
    expect(s.cursor).toBe(15);
  });

  it("an empty replacement truncates at the anchor", () => {
    const s = replaceSlashArg(at("/resume 2026", 12), 8, "");
    expect(s).toEqual({ text: "/resume ", cursor: 8 });
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
