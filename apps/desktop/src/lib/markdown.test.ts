import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown";

describe("parseInline", () => {
  it("splits inline code spans", () => {
    expect(parseInline("run `pnpm test` now")).toEqual([
      { code: false, text: "run " },
      { code: true, text: "pnpm test" },
      { code: false, text: " now" },
    ]);
  });

  it("keeps an unterminated backtick literal", () => {
    expect(parseInline("a `b")).toEqual([{ code: false, text: "a `b" }]);
  });

  it("handles plain text", () => {
    expect(parseInline("hello")).toEqual([{ code: false, text: "hello" }]);
  });
});

describe("parseMarkdown", () => {
  it("parses headings with levels", () => {
    const blocks = parseMarkdown("# Title\n\n### Sub");
    expect(blocks).toEqual([
      { kind: "heading", level: 1, inlines: [{ code: false, text: "Title" }] },
      { kind: "heading", level: 3, inlines: [{ code: false, text: "Sub" }] },
    ]);
  });

  it("parses unordered and ordered lists", () => {
    const blocks = parseMarkdown("- a\n- b\n\n1. one\n2. two");
    expect(blocks).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [[{ code: false, text: "a" }], [{ code: false, text: "b" }]],
      },
      {
        kind: "list",
        ordered: true,
        items: [[{ code: false, text: "one" }], [{ code: false, text: "two" }]],
      },
    ]);
  });

  it("parses fenced code blocks verbatim (no inline parsing inside)", () => {
    const blocks = parseMarkdown("```ts\nconst a = `tpl`;\n# not a heading\n```");
    expect(blocks).toEqual([{ kind: "code", lang: "ts", code: "const a = `tpl`;\n# not a heading" }]);
  });

  it("merges consecutive lines into one paragraph and splits on blanks", () => {
    const blocks = parseMarkdown("line one\nline two\n\nnext para");
    expect(blocks).toEqual([
      { kind: "para", inlines: [{ code: false, text: "line one line two" }] },
      { kind: "para", inlines: [{ code: false, text: "next para" }] },
    ]);
  });

  it("handles an unclosed fence to end of input", () => {
    const blocks = parseMarkdown("```\ncode here");
    expect(blocks).toEqual([{ kind: "code", lang: "", code: "code here" }]);
  });

  it("handles CJK content", () => {
    const blocks = parseMarkdown("## 标题\n\n- 列表项 `代码`");
    expect(blocks[0]).toEqual({ kind: "heading", level: 2, inlines: [{ code: false, text: "标题" }] });
    expect(blocks[1]).toEqual({
      kind: "list",
      ordered: false,
      items: [
        [
          { code: false, text: "列表项 " },
          { code: true, text: "代码" },
        ],
      ],
    });
  });
});
