import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";

describe("parseArgs", () => {
  it("tolerates the `--` separator that `pnpm … eval -- <flags>` forwards", () => {
    // The documented invocation reaches the CLI as ["--", "--list-variants"].
    expect(parseArgs(["--", "--list-variants"]).listVariants).toBe(true);
    expect(parseArgs(["--", "--ab", "control,no-retrieval"]).ab).toEqual(["control", "no-retrieval"]);
  });

  it("parses the same flags with no leading separator", () => {
    expect(parseArgs(["--list-variants"]).listVariants).toBe(true);
    expect(parseArgs(["--task", "cjk-buried-retry"]).taskId).toBe("cjk-buried-retry");
  });

  it("a bare `--` yields the defaults (no flags)", () => {
    const args = parseArgs(["--"]);
    expect(args.listVariants).toBe(false);
    expect(args.variants).toEqual([]);
  });

  it("still rejects a genuinely unknown argument", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument: --nope/);
  });
});
