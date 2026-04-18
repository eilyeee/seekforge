import { describe, expect, it } from "vitest";
import { createPasteRegistry, expandPastes, registerPaste, shouldPlaceholder } from "../paste.js";

describe("shouldPlaceholder", () => {
  it("is false at exactly 6 lines and 600 chars", () => {
    expect(shouldPlaceholder("a\nb\nc\nd\ne\nf")).toBe(false); // 6 lines
    expect(shouldPlaceholder("x".repeat(600))).toBe(false); // 600 chars
  });

  it("is true above either threshold", () => {
    expect(shouldPlaceholder("a\nb\nc\nd\ne\nf\ng")).toBe(true); // 7 lines
    expect(shouldPlaceholder("x".repeat(601))).toBe(true); // 601 chars
  });

  it("is false for small pastes", () => {
    expect(shouldPlaceholder("hello")).toBe(false);
  });
});

describe("registerPaste / expandPastes", () => {
  it("round-trips a single paste", () => {
    const reg = createPasteRegistry();
    const full = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const token = registerPaste(reg, full);
    expect(token).toBe("[Pasted text #1 (+10 lines)]");
    expect(expandPastes(reg, `before ${token} after`)).toBe(`before ${full} after`);
  });

  it("expands two pastes in one text and numbers them sequentially", () => {
    const reg = createPasteRegistry();
    const a = "aaa\n".repeat(8).trimEnd();
    const b = "bbb\n".repeat(9).trimEnd();
    const ta = registerPaste(reg, a);
    const tb = registerPaste(reg, b);
    expect(ta).toBe("[Pasted text #1 (+8 lines)]");
    expect(tb).toBe("[Pasted text #2 (+9 lines)]");
    expect(expandPastes(reg, `${ta}\n--\n${tb}`)).toBe(`${a}\n--\n${b}`);
  });

  it("leaves unknown tokens untouched", () => {
    const reg = createPasteRegistry();
    registerPaste(reg, "stored\ntext");
    const text = "see [Pasted text #9 (+99 lines)]";
    expect(expandPastes(reg, text)).toBe(text);
  });

  it("replaces repeated occurrences of the same token", () => {
    const reg = createPasteRegistry();
    const token = registerPaste(reg, "FULL");
    expect(expandPastes(reg, `${token} and ${token}`)).toBe("FULL and FULL");
  });
});
