import { describe, expect, it } from "vitest";
import { applyEdits } from "../../src/tools/edits.js";
import { ToolError } from "../../src/tools/errors.js";

const SRC = [
  "function add(a, b) {",
  "  return a + b;",
  "}",
  "",
  "function sub(a, b) {",
  "  return a - b;",
  "}",
  "",
].join("\n");

describe("applyEdits — exact matching", () => {
  it("applies a single exact edit", () => {
    const out = applyEdits(SRC, [{ oldString: "  return a + b;", newString: "  return a + b + 0;" }]);
    expect(out).toContain("  return a + b + 0;");
    expect(out).toContain("  return a - b;"); // untouched
  });

  it("exact match wins even when a fuzzy region also exists", () => {
    // oldString is verbatim; the fuzzy path must never be reached.
    const out = applyEdits(SRC, [{ oldString: "  return a + b;", newString: "  return ADD;" }]);
    expect(out).toContain("  return ADD;");
  });

  it("supports empty newString (deletion)", () => {
    const out = applyEdits(SRC, [{ oldString: "  return a + b;\n", newString: "" }]);
    expect(out).not.toContain("return a + b;");
  });

  it("rejects exact-but-ambiguous matches with ambiguous (no fuzzy fallback)", () => {
    try {
      applyEdits(SRC, [{ oldString: "function ", newString: "async function " }]);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("ambiguous");
      expect((e as ToolError).detail as { matchCount: number }).toMatchObject({ matchCount: 2 });
    }
  });

  it("rejects an empty oldString", () => {
    try {
      applyEdits(SRC, [{ oldString: "", newString: "x" }]);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("no_match");
    }
  });
});

describe("applyEdits — whitespace-tolerant fallback", () => {
  it("matches when leading indentation drifts and replaces the REAL text", () => {
    // Model used 6-space indent; file has 2-space. No exact substring exists,
    // so the fuzzy path runs and replaces the actual indented line.
    const out = applyEdits(SRC, [{ oldString: "      return a + b;", newString: "  return a + b + 1;" }]);
    expect(out).toContain("  return a + b + 1;");
    expect(out).not.toContain("  return a + b;\n}");
    // Surrounding real content preserved.
    expect(out.startsWith("function add(a, b) {\n")).toBe(true);
    expect(out).toContain("  return a - b;");
  });

  it("replaces the whole matched line when only the indentation differs", () => {
    // oldString has 4-space indent; file has 2-space. No exact substring exists,
    // so the fuzzy path runs and replaces the ENTIRE real line with newString.
    const out = applyEdits(SRC, [{ oldString: "    return a - b;", newString: "    return DIFF;" }]);
    const lines = out.split("\n");
    expect(lines).toContain("    return DIFF;");
    // The original two-space line is gone (replaced whole).
    expect(lines).not.toContain("  return a - b;");
    // The other function body keeps its original two-space indent.
    expect(lines).toContain("  return a + b;");
  });

  it("matches when trailing whitespace drifts", () => {
    const fileNoTrailing = "const x = 1;\nconst y = 2;\n";
    // oldString carries trailing spaces the file lacks -> no exact substring,
    // fuzzy normalizes trailing whitespace away and matches the real line.
    const out = applyEdits(fileNoTrailing, [{ oldString: "const x = 1;   ", newString: "const x = 99;" }]);
    expect(out).toBe("const x = 99;\nconst y = 2;\n");
  });

  it("matches a multi-line block with mixed indentation drift", () => {
    const file = ["if (cond) {", "    doThing();", "    doOther();", "}", ""].join("\n");
    const old = ["if (cond) {", "  doThing();", "  doOther();", "}"].join("\n");
    const out = applyEdits(file, [{ oldString: old, newString: "if (cond) { doBoth(); }" }]);
    expect(out).toBe("if (cond) { doBoth(); }\n");
  });

  it("is tolerant of CRLF line endings in the file (fuzzy path)", () => {
    // File uses CRLF; oldString uses LF + extra indent so no exact substring
    // exists. normalizeLine drops the CR, so the line still matches.
    const crlf = "alpha\r\nbeta\r\ngamma\r\n";
    // Trailing space means "beta " is not an exact substring; fuzzy normalizes it.
    const out = applyEdits(crlf, [{ oldString: "beta ", newString: "  BETA" }]);
    // The whole file stays consistently CRLF: the fuzzy path rejoins with the
    // file's dominant EOL, so the replaced line does NOT regress to a bare LF.
    expect(out).toBe("alpha\r\n  BETA\r\ngamma\r\n");
  });

  it("preserves each untouched line's own terminator in a MIXED-EOL file", () => {
    // Mixed endings on purpose: line 0 CRLF, line 1 LF, line 2 CRLF, line 3 LF,
    // final newline LF. A fuzzy edit on line 1 must not rewrite the terminators
    // of the CRLF lines it does not touch.
    const file = "alpha\r\nbeta\ngamma\r\ndelta\n";
    // Trailing space -> no exact substring; fuzzy normalizes it and matches "beta".
    const out = applyEdits(file, [{ oldString: "beta ", newString: "BETA" }]);
    // Untouched lines keep exactly their original CRLF vs LF terminators.
    expect(out).toBe("alpha\r\nBETA\ngamma\r\ndelta\n");
    // Specifically: the CRLF lines were NOT downgraded to LF...
    expect(out).toContain("alpha\r\n");
    expect(out).toContain("gamma\r\n");
    // ...and the LF-terminated edited line was NOT upgraded to CRLF.
    expect(out).toContain("BETA\n");
    expect(out).not.toContain("BETA\r\n");
  });

  it("keeps the replaced line's own terminator when it is CRLF in a mixed file", () => {
    // Here the edited line (gamma) is CRLF-terminated; the new block should stay
    // CRLF, while the surrounding LF/CRLF lines are each left untouched.
    const file = "alpha\nbeta\r\ngamma\r\ndelta\n";
    const out = applyEdits(file, [{ oldString: "gamma ", newString: "GAMMA" }]);
    expect(out).toBe("alpha\nbeta\r\nGAMMA\r\ndelta\n");
  });

  it("throws ambiguous when more than one fuzzy region matches (no silent guess)", () => {
    const file = ["  foo();", "bar();", "  foo();", "baz();", ""].join("\n");
    // "foo();" (no indent) fuzzy-matches both indented occurrences.
    try {
      applyEdits(file, [{ oldString: "foo();", newString: "qux();" }]);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("ambiguous");
      expect((e as ToolError).detail as { matchCount: number }).toMatchObject({ matchCount: 2 });
    }
  });

  it("throws no_match with a closestRegion hint when zero fuzzy regions match", () => {
    try {
      applyEdits(SRC, [{ oldString: "return a * b;", newString: "x" }]);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("no_match");
      expect((e as ToolError).detail as { hint: string }).toMatchObject({
        hint: expect.stringContaining("return a + b;"),
      });
    }
  });

  it("handles a single-line oldString with trailing newline via fuzzy", () => {
    // Extra indent forces the fuzzy path; trailing newline on oldString is stripped
    // before line comparison so it matches the single real line, not an extra blank.
    const out = applyEdits(SRC, [{ oldString: "        return a + b;\n", newString: "  return SUM;" }]);
    expect(out).toContain("  return SUM;");
    expect(out).not.toContain("return a + b;");
    expect(out).toContain("  return a - b;"); // untouched
  });
});

describe("applyEdits — all-or-nothing", () => {
  it("applies edits in order against the progressively-edited content", () => {
    const out = applyEdits(SRC, [
      { oldString: "  return a + b;", newString: "  return a + b + 0;" },
      { oldString: "  return a - b;", newString: "  return a - b - 0;" },
    ]);
    expect(out).toContain("  return a + b + 0;");
    expect(out).toContain("  return a - b - 0;");
  });

  it("throws (leaving no partial) when a later edit fails", () => {
    try {
      applyEdits(SRC, [
        { oldString: "  return a + b;", newString: "  return a + b + 0;" },
        { oldString: "DOES NOT EXIST ANYWHERE", newString: "x" },
      ]);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("no_match");
      // applyEdits is pure: it throws rather than returning a partially-edited string.
      // (The caller persists nothing because nothing is returned.)
    }
  });

  it("does not mutate the input content string", () => {
    const original = SRC;
    applyEdits(SRC, [{ oldString: "  return a + b;", newString: "  return CHANGED;" }]);
    expect(SRC).toBe(original);
  });
});
