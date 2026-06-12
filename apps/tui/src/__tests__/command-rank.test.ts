import { describe, expect, it } from "vitest";
import { bumpUsage, didYouMean, rankCommands, type CommandUsage } from "../command-rank.js";

const specs = [
  { name: "help", summary: "show all commands" },
  { name: "model", summary: "switch model for subsequent messages" },
  { name: "memory", summary: "list project memory facts" },
  { name: "diff", summary: "git diff of the working tree" },
  { name: "export", summary: "export the transcript as markdown" },
] as const;

describe("bumpUsage", () => {
  it("returns a new object and increments from zero", () => {
    const usage: CommandUsage = {};
    const next = bumpUsage(usage, "diff");
    expect(next).toEqual({ diff: 1 });
    expect(next).not.toBe(usage);
    expect(usage).toEqual({});
  });

  it("increments an existing count", () => {
    expect(bumpUsage({ diff: 2 }, "diff")).toEqual({ diff: 3 });
  });
});

describe("rankCommands", () => {
  it("empty query orders by usage desc, then registry order", () => {
    const got = rankCommands("", specs, { export: 3, memory: 1 });
    expect(got.map((s) => s.name)).toEqual(["export", "memory", "help", "model", "diff"]);
  });

  it("empty query with no usage keeps registry order", () => {
    expect(rankCommands("", specs, {}).map((s) => s.name)).toEqual([
      "help",
      "model",
      "memory",
      "diff",
      "export",
    ]);
  });

  it("non-empty query drops commands matching neither name nor summary", () => {
    const got = rankCommands("zzz", specs, {});
    expect(got).toEqual([]);
  });

  it("name matches rank above summary-only matches", () => {
    const local = [
      { name: "export", summary: "export the transcript as markdown" },
      { name: "markdown", summary: "render markdown previews" },
    ];
    // "mark" hits the name "markdown" and only the SUMMARY of "export".
    const got = rankCommands("mark", local, {});
    expect(got.map((s) => s.name)).toEqual(["markdown", "export"]);
  });

  it("summary-only matches are kept at half score", () => {
    // "transcript" appears only in export's summary.
    const got = rankCommands("transcript", specs, {});
    expect(got.map((s) => s.name)).toEqual(["export"]);
  });

  it("usage boost breaks near-ties between name matches", () => {
    // "m" matches "model" and "memory" with the same start-of-name score;
    // boosting memory should put it first.
    const plain = rankCommands("m", specs, {});
    expect(plain.map((s) => s.name).slice(0, 2)).toEqual(["model", "memory"]);
    const boosted = rankCommands("m", specs, { memory: 7 });
    expect(boosted[0]?.name).toBe("memory");
  });

  it("applies the limit", () => {
    expect(rankCommands("", specs, {}, 2)).toHaveLength(2);
  });
});

describe("didYouMean", () => {
  it("recovers a transposition typo", () => {
    expect(didYouMean("hlep", specs)).toBe("help");
  });

  it("matches a truncated name", () => {
    expect(didYouMean("memo", specs)).toBe("memory");
  });

  it("returns null for garbage", () => {
    expect(didYouMean("zzzzzz", specs)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(didYouMean("", specs)).toBeNull();
    expect(didYouMean("   ", specs)).toBeNull();
  });
});
