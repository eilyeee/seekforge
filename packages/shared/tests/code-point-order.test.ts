import { describe, expect, it } from "vitest";
import { compareByCodePoints } from "../src/index.js";

/**
 * The claim this comparator makes is not "some deterministic order" — it is
 * "the same order the Rust runtime produces". Rust's `Ord` on `str` compares
 * UTF-8 bytes, and `Buffer.from(s)` is that exact byte sequence, so
 * `Buffer.compare` is the reference implementation available from here. Every
 * test below is that one assertion on inputs chosen to break it.
 */
function byteOrder(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function agrees(left: string, right: string): void {
  expect(Math.sign(compareByCodePoints(left, right)), `${left} vs ${right}`).toBe(Math.sign(byteOrder(left, right)));
  expect(Math.sign(compareByCodePoints(right, left)), `${right} vs ${left}`).toBe(Math.sign(byteOrder(right, left)));
}

describe("compareByCodePoints", () => {
  it("agrees with UTF-8 byte order on ASCII", () => {
    for (const pair of [
      ["a.md", "B.md"],
      ["README.md", "a.md"],
      ["", "a"],
      ["a", "aa"],
      ["a-b", "a.b"],
      ["a", "a"],
    ]) {
      agrees(pair[0] as string, pair[1] as string);
    }
  });

  it("agrees on accents and non-Latin scripts, where collators would not", () => {
    // Under sv-SE a collator puts "ä" after "z"; under en-US beside "a".
    // Byte order has one answer and it is neither.
    for (const pair of [
      ["ä.md", "z.md"],
      ["ä.md", "a.md"],
      ["日本.md", "z.md"],
      ["Ω.md", "a.md"],
    ]) {
      agrees(pair[0] as string, pair[1] as string);
    }
  });

  it("agrees on supplementary characters, where UTF-16 code units would not", () => {
    // The reason this is not `left < right`. An emoji is a surrogate pair
    // starting at 0xD800, so JavaScript's `<` sorts it BELOW U+E000–U+FFFF
    // while UTF-8 bytes — and Rust — sort it above.
    // Written as escapes on purpose. U+F900 is the CJK compatibility ideograph,
    // visually identical to the ordinary U+8C48 — and U+8C48 sits below the
    // surrogates, so pasting the glyph would have tested nothing at all.
    const emoji = "\u{1F642}.md"; // a surrogate pair: 0xD83D 0xDE42
    const compat = "\uF900.md"; // one code unit, above the surrogates
    const pua = "\uE000.md"; // the first code point past the surrogates

    expect(emoji < compat).toBe(true); // what code-unit order claims…
    expect(byteOrder(emoji, compat)).toBeGreaterThan(0); // …and what is true.
    agrees(emoji, compat);
    agrees(emoji, pua);
    agrees(compat, pua);
    agrees(emoji, "z.md");
    agrees("\u{10000}", "\uF900"); // the first supplementary code point
  });

  it("sorts a whole listing the way the bytes do", () => {
    const names = ["z.md", "\u{1F642}.md", "a.md", "\uF900.md", "B.md", "ä.md", "README.md", "\uE000.md"];
    expect([...names].sort(compareByCodePoints)).toEqual([...names].sort(byteOrder));
  });

  it("returns 0 only for equal strings, and is antisymmetric", () => {
    const corpus = ["a", "A", "ä", "z", "\u{1F642}", "\uF900", "\uE000", "", "aa", "\u{10000}"];
    for (const left of corpus) {
      for (const right of corpus) {
        const forward = compareByCodePoints(left, right);
        expect(forward === 0).toBe(left === right);
        expect(Math.sign(forward) + Math.sign(compareByCodePoints(right, left))).toBe(0);
      }
    }
  });

  it("orders a lone surrogate without throwing or claiming equality", () => {
    // Not valid UTF-8, so there is no byte order to agree with — the contract
    // here is only that it stays a total order rather than becoming a crash.
    const lone = "\ud800x";
    expect(compareByCodePoints(lone, "a")).toBeGreaterThan(0);
    expect(compareByCodePoints(lone, lone)).toBe(0);
    expect(Math.sign(compareByCodePoints(lone, "豈"))).toBe(-Math.sign(compareByCodePoints("豈", lone)));
  });
});
