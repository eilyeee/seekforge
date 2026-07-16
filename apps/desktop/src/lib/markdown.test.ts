import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown";

const t = (text: string) => ({ kind: "text" as const, text });

describe("parseInline", () => {
  it("splits inline code spans", () => {
    expect(parseInline("run `pnpm test` now")).toEqual([t("run "), { kind: "code", text: "pnpm test" }, t(" now")]);
  });

  it("keeps an unterminated backtick literal", () => {
    expect(parseInline("a `b")).toEqual([t("a `b")]);
  });

  it("handles plain text", () => {
    expect(parseInline("hello")).toEqual([t("hello")]);
  });

  it("parses bold and italic", () => {
    expect(parseInline("a **bold** and *em*")).toEqual([
      t("a "),
      { kind: "strong", children: [t("bold")] },
      t(" and "),
      { kind: "em", children: [t("em")] },
    ]);
  });

  it("parses bold-italic", () => {
    expect(parseInline("***wow***")).toEqual([{ kind: "strong", children: [{ kind: "em", children: [t("wow")] }] }]);
  });

  it("parses underscore emphasis", () => {
    expect(parseInline("__b__ _i_")).toEqual([
      { kind: "strong", children: [t("b")] },
      t(" "),
      { kind: "em", children: [t("i")] },
    ]);
  });

  it("parses inline links", () => {
    expect(parseInline("see [docs](https://x.dev/a) here")).toEqual([
      t("see "),
      { kind: "link", href: "https://x.dev/a", children: [t("docs")] },
      t(" here"),
    ]);
  });

  it("auto-links bare http(s) URLs", () => {
    expect(parseInline("go to https://example.com/p now")).toEqual([
      t("go to "),
      { kind: "link", href: "https://example.com/p", children: [t("https://example.com/p")] },
      t(" now"),
    ]);
  });

  it("does not autolink trailing punctuation into the URL", () => {
    const out = parseInline("(https://example.com).");
    const link = out.find((s) => s.kind === "link");
    expect(link).toEqual({
      kind: "link",
      href: "https://example.com",
      children: [t("https://example.com")],
    });
  });

  it("falls back to literal text on a malformed link (streaming-partial)", () => {
    expect(parseInline("[half link](http")).toEqual([t("[half link](http")]);
    expect(parseInline("[no paren]")).toEqual([t("[no paren]")]);
  });

  it("keeps an unterminated emphasis run literal", () => {
    expect(parseInline("a **bold")).toEqual([t("a **bold")]);
  });

  it("does not treat ' * ' multiplication as emphasis", () => {
    expect(parseInline("a * b * c")).toEqual([t("a * b * c")]);
  });

  it("handles nested emphasis inside bold", () => {
    expect(parseInline("**a `b` c**")).toEqual([
      {
        kind: "strong",
        children: [t("a "), { kind: "code", text: "b" }, t(" c")],
      },
    ]);
  });
});

describe("parseMarkdown", () => {
  it("parses headings with levels", () => {
    const blocks = parseMarkdown("# Title\n\n### Sub");
    expect(blocks).toEqual([
      { kind: "heading", level: 1, inlines: [t("Title")] },
      { kind: "heading", level: 3, inlines: [t("Sub")] },
    ]);
  });

  it("parses unordered and ordered lists", () => {
    const blocks = parseMarkdown("- a\n- b\n\n1. one\n2. two");
    expect(blocks).toEqual([
      { kind: "list", ordered: false, items: [{ inlines: [t("a")] }, { inlines: [t("b")] }] },
      { kind: "list", ordered: true, items: [{ inlines: [t("one")] }, { inlines: [t("two")] }] },
    ]);
  });

  it("parses nested lists via indentation", () => {
    const blocks = parseMarkdown("- a\n  - a1\n  - a2\n- b");
    expect(blocks).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          {
            inlines: [t("a")],
            children: [
              {
                kind: "list",
                ordered: false,
                items: [{ inlines: [t("a1")] }, { inlines: [t("a2")] }],
              },
            ],
          },
          { inlines: [t("b")] },
        ],
      },
    ]);
  });

  it("parses fenced code blocks verbatim with the info-string language", () => {
    const blocks = parseMarkdown("```ts\nconst a = `tpl`;\n# not a heading\n```");
    expect(blocks).toEqual([{ kind: "code", lang: "ts", code: "const a = `tpl`;\n# not a heading" }]);
  });

  it("parses a GFM table", () => {
    const blocks = parseMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |");
    expect(blocks).toEqual([
      {
        kind: "table",
        header: [[t("a")], [t("b")]],
        rows: [
          [[t("1")], [t("2")]],
          [[t("3")], [t("4")]],
        ],
      },
    ]);
  });

  it("treats a pipe row with no separator as a paragraph (malformed table)", () => {
    const blocks = parseMarkdown("| a | b |\n| 1 | 2 |");
    expect(blocks[0]?.kind).toBe("para");
  });

  it("renders a half-written table header without a separator as plain text", () => {
    const blocks = parseMarkdown("| a | b |");
    expect(blocks).toEqual([{ kind: "para", inlines: [t("| a | b |")] }]);
  });

  it("parses blockquotes (with nested blocks)", () => {
    const blocks = parseMarkdown("> quoted line\n> - item");
    expect(blocks).toEqual([
      {
        kind: "blockquote",
        children: [
          { kind: "para", inlines: [t("quoted line")] },
          { kind: "list", ordered: false, items: [{ inlines: [t("item")] }] },
        ],
      },
    ]);
  });

  it("parses horizontal rules", () => {
    const blocks = parseMarkdown("a\n\n---\n\nb");
    expect(blocks).toEqual([{ kind: "para", inlines: [t("a")] }, { kind: "hr" }, { kind: "para", inlines: [t("b")] }]);
  });

  it("merges consecutive lines into one paragraph and splits on blanks", () => {
    const blocks = parseMarkdown("line one\nline two\n\nnext para");
    expect(blocks).toEqual([
      { kind: "para", inlines: [t("line one line two")] },
      { kind: "para", inlines: [t("next para")] },
    ]);
  });

  it("handles an unclosed fence to end of input", () => {
    const blocks = parseMarkdown("```\ncode here");
    expect(blocks).toEqual([{ kind: "code", lang: "", code: "code here" }]);
  });

  it("does not crash on a half-written link mid-stream", () => {
    expect(() => parseMarkdown("here is [a link](http")).not.toThrow();
    const blocks = parseMarkdown("here is [a link](http");
    expect(blocks[0]).toEqual({ kind: "para", inlines: [t("here is [a link](http")] });
  });

  it("handles CJK content", () => {
    const blocks = parseMarkdown("## 标题\n\n- 列表项 `代码`");
    expect(blocks[0]).toEqual({ kind: "heading", level: 2, inlines: [t("标题")] });
    expect(blocks[1]).toEqual({
      kind: "list",
      ordered: false,
      items: [{ inlines: [t("列表项 "), { kind: "code", text: "代码" }] }],
    });
  });
});
