import { describe, expect, it } from "vitest";
import {
  currentMatch,
  searchBackspace,
  searchInput,
  searchNext,
  startSearch,
  type HistorySearch,
} from "../history-search.js";

/** Oldest→newest, like loadHistory returns. */
const ENTRIES = [
  "git status", // 0
  "pnpm test", // 1
  "Git Push origin", // 2
  "ls -la", // 3
  "git pull", // 4
] as const;

function type(s: HistorySearch, entries: readonly string[], text: string): HistorySearch {
  let out = s;
  for (const char of text) out = searchInput(out, entries, char);
  return out;
}

describe("startSearch", () => {
  it("begins empty with no matches", () => {
    expect(startSearch()).toEqual({ query: "", matches: [], cursor: 0 });
  });
});

describe("searchInput", () => {
  it("matches newest-first (highest index examined first)", () => {
    const s = type(startSearch(), ENTRIES, "git");
    expect(s.matches).toEqual([4, 2, 0]);
    expect(s.cursor).toBe(0);
    expect(currentMatch(s, ENTRIES)).toBe("git pull");
  });

  it("is case-insensitive", () => {
    const s = type(startSearch(), ENTRIES, "GIT PU");
    expect(s.matches).toEqual([4, 2]); // "git pull" and "Git Push origin"
  });

  it("narrows incrementally as characters are appended", () => {
    let s = type(startSearch(), ENTRIES, "g");
    expect(s.matches).toEqual([4, 2, 0]); // "pnpm test" has no g
    s = type(s, ENTRIES, "it");
    expect(s.matches).toEqual([4, 2, 0]);
    s = type(s, ENTRIES, " st");
    expect(s.matches).toEqual([0]);
  });

  it("resets the cursor to 0 on every keystroke", () => {
    let s = type(startSearch(), ENTRIES, "git");
    s = searchNext(s);
    expect(s.cursor).toBe(1);
    s = searchInput(s, ENTRIES, " ");
    expect(s.cursor).toBe(0);
  });

  it("empty query yields no matches (not all)", () => {
    const s = startSearch();
    expect(s.matches).toEqual([]);
    expect(currentMatch(s, ENTRIES)).toBeNull();
  });

  it("no-match query yields empty matches and null currentMatch", () => {
    const s = type(startSearch(), ENTRIES, "zzz");
    expect(s.matches).toEqual([]);
    expect(currentMatch(s, ENTRIES)).toBeNull();
  });
});

describe("searchNext (repeated Ctrl+R)", () => {
  it("steps to the next-older match and clamps at the oldest", () => {
    let s = type(startSearch(), ENTRIES, "git");
    expect(currentMatch(s, ENTRIES)).toBe("git pull");
    s = searchNext(s);
    expect(currentMatch(s, ENTRIES)).toBe("Git Push origin");
    s = searchNext(s);
    expect(currentMatch(s, ENTRIES)).toBe("git status");
    s = searchNext(s); // clamped
    expect(s.cursor).toBe(2);
    expect(currentMatch(s, ENTRIES)).toBe("git status");
  });

  it("is a no-op when there are no matches", () => {
    const s = searchNext(startSearch());
    expect(s).toEqual({ query: "", matches: [], cursor: 0 });
  });
});

describe("searchBackspace", () => {
  it("widens the match set and resets the cursor", () => {
    let s = type(startSearch(), ENTRIES, "git s");
    expect(s.matches).toEqual([0]);
    s = searchNext(s);
    s = searchBackspace(s, ENTRIES);
    expect(s.query).toBe("git ");
    expect(s.matches).toEqual([4, 2, 0]);
    expect(s.cursor).toBe(0);
  });

  it("backspacing to an empty query clears the matches", () => {
    let s = type(startSearch(), ENTRIES, "l");
    s = searchBackspace(s, ENTRIES);
    expect(s).toEqual({ query: "", matches: [], cursor: 0 });
  });

  it("is safe on an already-empty query", () => {
    const s = searchBackspace(startSearch(), ENTRIES);
    expect(s).toEqual({ query: "", matches: [], cursor: 0 });
  });
});

it("removes one complete grapheme from the reverse-search query", () => {
  const entries = ["prefix e\u0301", "prefix 👨‍👩‍👧‍👦"];
  const family = type(startSearch(), entries, "👨‍👩‍👧‍👦");
  expect(searchBackspace(family, entries).query).toBe("");

  const combining = type(startSearch(), entries, "e\u0301");
  expect(searchBackspace(combining, entries).query).toBe("");
});

describe("multiline entries", () => {
  const multi = ["first line\nsecond line", "plain"] as const;

  it("matches across the full text including past the newline", () => {
    const s = type(startSearch(), multi, "second");
    expect(s.matches).toEqual([0]);
  });

  it("matches a substring spanning the newline itself", () => {
    const s = type(startSearch(), multi, "line\nsecond");
    expect(s.matches).toEqual([0]);
  });

  it("currentMatch returns the entry verbatim", () => {
    const s = type(startSearch(), multi, "second");
    expect(currentMatch(s, multi)).toBe("first line\nsecond line");
  });
});
