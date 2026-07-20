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

  it("rejects conflicting variants and an incomplete regression gate", () => {
    expect(() => parseArgs(["--variant", "control", "--variant", "verify-gate"])).toThrow(/only once/);
    expect(() => parseArgs(["--variant", "control", "--ab", "control,verify-gate"])).toThrow(/cannot be combined/);
    expect(() => parseArgs(["--fail-on-regression"])).toThrow(/requires --baseline/);
    expect(() => parseArgs(["--task", ""])).toThrow(/requires a task id/);
  });

  it("parses continuous-eval options", () => {
    const args = parseArgs(["--suite", "nightly", "--repeat", "3", "--junit", "out/junit.xml", "--require-api-key"]);
    expect(args.suite).toBe("nightly");
    expect(args.repeat).toBe(3);
    expect(args.junit).toBe("out/junit.xml");
    expect(args.requireApiKey).toBe(true);
    expect(parseArgs(["--ab", "control,verify-gate", "--repeat", "3"])).toMatchObject({
      ab: ["control", "verify-gate"],
      repeat: 3,
    });
  });

  it("rejects missing and unsafe repeat counts", () => {
    for (const value of [
      undefined,
      "0",
      "-1",
      "+1",
      "1.5",
      "1e1",
      "0x10",
      " 3 ",
      "21",
      "NaN",
      "Infinity",
      "9007199254740992",
    ]) {
      const argv = value === undefined ? ["--repeat"] : ["--repeat", value];
      expect(() => parseArgs(argv)).toThrow(/integer from 1 to 20/);
    }
  });

  it.each(["--suite", "--junit", "--baseline", "--variant"])("rejects an empty value for %s", (flag) => {
    expect(() => parseArgs([flag, "  "])).toThrow(/requires/);
  });
});
