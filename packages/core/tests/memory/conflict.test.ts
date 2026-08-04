import { describe, expect, it } from "vitest";
import { contradicts, findConflicts, negated, similarity } from "../../src/memory/conflict.js";
import { buildMemoryBrief } from "../../src/memory/index.js";
import { makeWorkspace, writeProjectMemory } from "./helpers.js";

/**
 * Memory is append-only, so the fact a later one replaced is still in the file.
 * Both can rank highly for the same task, and presenting them side by side as
 * equally true is the one way remembering things makes an agent worse.
 */

describe("when two facts cannot both be true", () => {
  it("catches a fact its replacement negates", () => {
    expect(contradicts("use pnpm for every install", "do not use pnpm for installs")).toBe(true);
    expect(contradicts("部署前必须运行迁移", "部署前不要运行迁移")).toBe(true);
  });

  it("catches the same claim carrying a different value", () => {
    // This is what an outdated fact usually looks like, and a negation-only
    // check misses all of it.
    expect(contradicts("the dev server runs on port 7373", "the dev server runs on port 8080")).toBe(true);
    expect(contradicts("release requires node 20", "release requires node 22")).toBe(true);
  });

  it("does not call agreement a conflict", () => {
    expect(contradicts("the dev server runs on port 7373", "the dev server runs on port 7373")).toBe(false);
    // Unrelated facts that happen to share a number.
    expect(contradicts("supports node 20", "keeps 20 sessions on disk")).toBe(false);
    // Same subject, no competing value and no negation.
    expect(contradicts("the api lives in apps/server", "the api is written in typescript")).toBe(false);
  });

  it("compares what a sentence claims, not its polarity", () => {
    // The negation is stripped before comparing: "use pnpm" and "do not use
    // pnpm" are the same claim with opposite signs. Leaving it in made the two
    // look LESS alike the more explicitly they disagreed.
    expect(similarity("deploy with make ship", "do not deploy with make ship")).toBeGreaterThan(0.7);
    expect(negated("do not deploy on friday")).toBe(true);
    expect(negated("deploy on friday")).toBe(false);
  });

  it("compares Chinese by character on both sides or on neither", () => {
    // Removing a CJK marker used to leave a gap, which turned one side into
    // words and the other into characters — a sentence and its own negation
    // then had zero overlap.
    expect(similarity("部署前必须运行迁移", "部署前不要运行迁移")).toBeGreaterThan(0.7);
  });
});

describe("the brief says so when it injects a disagreement", () => {
  const facts = (extra: string[]): string =>
    [
      "# Project Memory",
      ...Array.from({ length: 24 }, (_, i) => `- [tech] unrelated fact number ${i} about the build`),
      ...extra,
    ].join("\n");

  it("warns, naming both facts, without dropping either", () => {
    const ws = makeWorkspace();
    writeProjectMemory(
      ws,
      facts(["- [command] the dev server runs on port 7373", "- [command] the dev server runs on port 8080"]),
    );
    const brief = buildMemoryBrief(ws, "start the dev server")!;
    expect(brief).toContain("7373");
    expect(brief).toContain("8080");
    expect(brief).toContain("at most one is current");
  });

  it("stays quiet when the facts agree", () => {
    const ws = makeWorkspace();
    writeProjectMemory(ws, facts(["- [command] the dev server runs on port 7373"]));
    const brief = buildMemoryBrief(ws, "start the dev server")!;
    expect(brief).toContain("7373");
    expect(brief).not.toContain("at most one is current");
  });

  it("never drops a fact to make room for the warning", () => {
    // The warning is an addition; trading a fact for it would swap one problem
    // for another.
    const ws = makeWorkspace();
    writeProjectMemory(
      ws,
      facts(["- [command] deploy with `make ship`", "- [command] do not deploy with `make ship`"]),
    );
    const brief = buildMemoryBrief(ws, "deploy the app")!;
    const bullets = brief.split("\n").filter((line) => line.startsWith("- "));
    expect(bullets.some((line) => line.includes("do not deploy"))).toBe(true);
    expect(bullets.some((line) => line.includes("deploy with"))).toBe(true);
  });
});

describe("a numbered list is not a disagreement", () => {
  it("reports two facts that differ by a value, and stays silent about many", () => {
    // Two sentences differing only by a number is a replacement nobody deleted.
    // A dozen of them is an enumeration, and no pairwise test can tell those
    // apart — only the shape of the whole set can.
    const replaced = findConflicts([
      { key: "command", text: "the dev server runs on port 7373" },
      { key: "command", text: "the dev server runs on port 8080" },
    ]);
    expect(replaced).toHaveLength(1);

    const enumerated = findConflicts(
      Array.from({ length: 6 }, (_, i) => ({ key: "command", text: `run stage ${i} of the pipeline` })),
    );
    expect(enumerated).toEqual([]);
  });

  it("keeps negation conflicts pairwise, since lists of negations do not happen", () => {
    const pairs = findConflicts([
      { key: "command", text: "deploy with make ship" },
      { key: "command", text: "do not deploy with make ship" },
      { key: "command", text: "run stage 1 of the pipeline" },
      { key: "command", text: "run stage 2 of the pipeline" },
      { key: "command", text: "run stage 3 of the pipeline" },
    ]);
    expect(pairs).toEqual([{ left: 0, right: 1 }]);
  });

  it("never pairs facts of different types", () => {
    expect(
      findConflicts([
        { key: "command", text: "use the flag --fast" },
        { key: "tech", text: "do not use the flag --fast" },
      ]),
    ).toEqual([]);
  });
});
