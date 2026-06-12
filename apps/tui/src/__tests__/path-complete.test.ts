import { describe, expect, it } from "vitest";
import type { EditorState } from "../editor.js";
import {
  applyCompletion,
  cycleCompletion,
  startCompletion,
  type PathCompletion,
} from "../path-complete.js";

function at(text: string, cursor: number): EditorState {
  return { text, cursor };
}

function must(c: PathCompletion | null): PathCompletion {
  if (c === null) throw new Error("expected a completion");
  return c;
}

function end(text: string): EditorState {
  return { text, cursor: text.length };
}

const FILES = [
  "README.md",
  "package.json",
  "src/app.tsx",
  "src/edit-helpers.ts",
  "src/editor.ts",
  "src/model.ts",
  "docs/editor-notes.md",
] as const;

describe("startCompletion — token extraction", () => {
  it("completes a path token at the end of the buffer", () => {
    const c = startCompletion(end("open src/edi"), FILES);
    expect(c).not.toBeNull();
    expect(c?.anchor).toBe(5);
    expect(c?.candidates).toEqual(["src/edit-helpers.ts", "src/editor.ts"]);
    expect(c?.index).toBe(0);
  });

  it("completes a token mid-sentence (cursor inside the token)", () => {
    // cursor right after "src/edi" in "open src/editing please"
    const c = startCompletion(at("open src/editing please", 12), FILES);
    expect(c?.anchor).toBe(5);
    expect(c?.candidates).toEqual(["src/edit-helpers.ts", "src/editor.ts"]);
  });

  it("returns null for an empty token (cursor after whitespace or at 0)", () => {
    expect(startCompletion(at("open ", 5), FILES)).toBeNull();
    expect(startCompletion(at("", 0), FILES)).toBeNull();
  });

  it("returns null for @ tokens (the file picker owns those)", () => {
    expect(startCompletion(end("see @src/edi"), FILES)).toBeNull();
  });

  it("returns null for '/' + a known slash-command name", () => {
    expect(startCompletion(end("/help"), FILES)).toBeNull();
    expect(startCompletion(end("/exit"), FILES)).toBeNull();
  });

  it("returns null for '#'/'!' prefixed tokens at line start", () => {
    expect(startCompletion(end("#src/edi"), FILES)).toBeNull();
    expect(startCompletion(end("!./run.sh"), FILES)).toBeNull();
  });

  it("still completes path tokens later on a '!' line", () => {
    const c = startCompletion(end("!cat src/edi"), FILES);
    expect(c?.anchor).toBe(5);
    expect(c?.candidates).toEqual(["src/edit-helpers.ts", "src/editor.ts"]);
  });

  it("returns null for a plain word with no path hints and no file prefix", () => {
    expect(startCompletion(end("hello"), FILES)).toBeNull();
  });

  it("accepts a hint-less token that is a known file prefix", () => {
    const c = startCompletion(end("look at REA"), FILES);
    expect(c?.candidates).toEqual(["README.md"]);
  });

  it("returns null when nothing matches at all", () => {
    expect(startCompletion(end("zzz/qqq"), FILES)).toBeNull();
  });
});

describe("startCompletion — ranking", () => {
  it("ranks full-path prefixes before segment-boundary prefixes", () => {
    // "edit" prefixes no full path but the segments "edit-helpers.ts",
    // "editor.ts", and "editor-notes.md"; add a file that full-path-prefixes.
    const files = ["edit.log", ...FILES];
    const c = startCompletion(end("edit"), files);
    expect(c?.candidates).toEqual([
      "edit.log",
      "src/edit-helpers.ts",
      "src/editor.ts",
      "docs/editor-notes.md",
    ]);
  });

  it("prefers prefix matches over fuzzy (fuzzy-only files excluded when prefixes exist)", () => {
    const c = startCompletion(end("src/m"), FILES);
    // Fuzzy would also match e.g. "src/edit-helpers.ts" ("src/" + later "m"
    // is absent — but "src/model.ts" is the only prefix match).
    expect(c?.candidates).toEqual(["src/model.ts"]);
  });

  it("falls back to fuzzy when nothing prefix-matches", () => {
    // "ap.tsx" is a subsequence of "src/app.tsx" only; no prefix matches.
    const c = startCompletion(end("ap.tsx"), FILES);
    expect(c?.candidates).toEqual(["src/app.tsx"]);
  });
});

describe("applyCompletion", () => {
  it("replaces the token, no trailing space, cursor at the end of the path", () => {
    const editor = end("open src/edi");
    const c = must(startCompletion(editor, FILES));
    const applied = applyCompletion(editor, c);
    expect(applied.text).toBe("open src/edit-helpers.ts");
    expect(applied.cursor).toBe(applied.text.length);
  });

  it("replaces the whole token on a multi-token line, keeping the tail", () => {
    const editor = at("open src/editing please now", 12); // cursor after "src/edi"
    const c = must(startCompletion(editor, FILES));
    const applied = applyCompletion(editor, c);
    expect(applied.text).toBe("open src/edit-helpers.ts please now");
    expect(applied.cursor).toBe("open src/edit-helpers.ts".length);
  });

  it("supports the app-side Tab loop: apply, cycle, re-apply at the original anchor", () => {
    const editor = end("open src/edi");
    let c = must(startCompletion(editor, FILES));
    let applied = applyCompletion(editor, c);
    expect(applied.text).toBe("open src/edit-helpers.ts");

    c = cycleCompletion(c);
    applied = applyCompletion(applied, c);
    expect(applied.text).toBe("open src/editor.ts");
    expect(applied.cursor).toBe(applied.text.length);

    c = cycleCompletion(c); // wraps back to the first candidate
    applied = applyCompletion(applied, c);
    expect(applied.text).toBe("open src/edit-helpers.ts");
  });
});

describe("cycleCompletion", () => {
  it("increments and wraps modulo the candidate count", () => {
    const c = { anchor: 0, candidates: ["a.ts", "b.ts", "c.ts"], index: 0 };
    expect(cycleCompletion(c).index).toBe(1);
    expect(cycleCompletion(cycleCompletion(c)).index).toBe(2);
    expect(cycleCompletion(cycleCompletion(cycleCompletion(c))).index).toBe(0);
  });
});
