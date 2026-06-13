import { describe, expect, it } from "vitest";
import { parseFileRef } from "./Markdown";

describe("parseFileRef", () => {
  it("recognizes paths with a slash, with optional :line", () => {
    expect(parseFileRef("src/foo.ts")).toEqual({ path: "src/foo.ts" });
    expect(parseFileRef("src/foo.ts:12")).toEqual({ path: "src/foo.ts", line: 12 });
    expect(parseFileRef("./a/b.tsx:3:5")).toEqual({ path: "a/b.tsx", line: 3 });
    expect(parseFileRef("@src/x.ts")).toEqual({ path: "src/x.ts" });
  });

  it("recognizes slash-less names only with a known file extension", () => {
    expect(parseFileRef("package.json")).toEqual({ path: "package.json" });
    expect(parseFileRef("README.md")).toEqual({ path: "README.md" });
    expect(parseFileRef("a.length")).toBeNull(); // unknown ext → not a path
    expect(parseFileRef("obj.method")).toBeNull();
  });

  it("rejects URLs, spaces, and empty input", () => {
    expect(parseFileRef("https://x.com/a.js")).toBeNull();
    expect(parseFileRef("hello world.ts")).toBeNull();
    expect(parseFileRef("")).toBeNull();
  });
});
