import { describe, expect, it } from "vitest";
import { fuzzyMatch, fuzzyRank } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("matches a subsequence and reports positions", () => {
    const m = fuzzyMatch("fv", "src/views/FilesView.tsx");
    expect(m).not.toBeNull();
    expect(m!.positions.length).toBe(2);
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("FV", "filesview.ts")).not.toBeNull();
  });

  it("returns null when not all query chars appear in order", () => {
    expect(fuzzyMatch("xyz", "abc.ts")).toBeNull();
    expect(fuzzyMatch("vf", "FilesView")).toBeNull(); // order matters
  });

  it("empty query matches with score 0", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
  });

  it("scores a consecutive / boundary match higher than a scattered one", () => {
    const consecutive = fuzzyMatch("file", "file.ts")!;
    const scattered = fuzzyMatch("file", "f_i_l_e_x_y.ts")!;
    expect(consecutive.score).toBeGreaterThan(scattered.score);
  });
});

describe("fuzzyRank", () => {
  it("keeps only matches, best score first", () => {
    const paths = ["src/app.ts", "src/views/FilesView.tsx", "README.md"];
    const ranked = fuzzyRank("fv", paths, (p) => p);
    expect(ranked.map((r) => r.item)).toEqual(["src/views/FilesView.tsx"]);
  });

  it("ranks a tighter match above a looser one", () => {
    const ranked = fuzzyRank("app", ["src/app.ts", "src/a_p_p_lication.ts"], (p) => p);
    expect(ranked[0]!.item).toBe("src/app.ts");
  });
});
