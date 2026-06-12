import { describe, expect, it } from "vitest";
import { highlightLines, type CodeToken } from "../highlight.js";

const rejoin = (rows: CodeToken[][]): string =>
  rows.map((row) => row.map((t) => t.text).join("")).join("\n");

const find = (row: CodeToken[], text: string): CodeToken | undefined =>
  row.find((t) => t.text === text);

describe("highlightLines", () => {
  it("colors ts keywords, strings, and line comments", () => {
    const [row] = highlightLines('const x = "hi"; // note', "ts");
    expect(find(row!, "const")?.color).toBe("magenta");
    expect(find(row!, '"hi"')?.color).toBe("green");
    expect(find(row!, "// note")?.color).toBe("gray");
    expect(find(row!, "x")?.color).toBeUndefined();
  });

  it("carries a block comment across lines", () => {
    const rows = highlightLines("let a = 1; /* start\nmiddle\nend */ let b = 2;", "typescript");
    expect(find(rows[0]!, "let")?.color).toBe("magenta");
    expect(find(rows[0]!, "/* start")?.color).toBe("gray");
    expect(rows[1]).toEqual([{ text: "middle", color: "gray" }]);
    expect(find(rows[2]!, "end */")?.color).toBe("gray");
    expect(find(rows[2]!, "let")?.color).toBe("magenta");
    expect(find(rows[2]!, "2")?.color).toBe("yellow");
  });

  it("treats # as a comment in python but not in ts", () => {
    const [py] = highlightLines("x = 1  # count", "py");
    expect(find(py!, "# count")?.color).toBe("gray");
    const [ts] = highlightLines("x = 1  # count", "ts");
    expect(find(ts!, "# count")).toBeUndefined();
  });

  it("colors json numbers and strings", () => {
    const [row] = highlightLines('{"a": 12.5, "ok": true}', "json");
    expect(find(row!, "12.5")?.color).toBe("yellow");
    expect(find(row!, '"a"')?.color).toBe("green");
    expect(find(row!, "true")?.color).toBe("yellow");
  });

  it("returns plain tokens for an unknown or absent lang", () => {
    for (const lang of ["brainfuck", undefined]) {
      const rows = highlightLines('const x = "hi"; // note', lang);
      expect(rows).toEqual([[{ text: 'const x = "hi"; // note' }]]);
    }
  });

  it("tolerates an unterminated string without throwing", () => {
    const [row] = highlightLines('const s = "oops', "js");
    expect(find(row!, '"oops')?.color).toBe("green");
  });

  it("preserves the input text exactly", () => {
    const code = "fn main() {\n  let x = 0.5; // half\n}";
    expect(rejoin(highlightLines(code, "rust"))).toBe(code);
    expect(rejoin(highlightLines(code))).toBe(code);
  });
});
