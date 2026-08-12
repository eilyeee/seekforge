import { describe, expect, it } from "vitest";
import {
  MAX_LOOP_TIMEOUT_MS,
  MAX_LOOP_VERIFICATION_STAGES,
  isVerificationPathPrefix,
  normalizeVerificationPath,
  parseLoopVerificationPlan,
} from "../src/loop-verification-contract.js";
import { parseClientFrame } from "../src/ws-protocol.js";

const limits = { maxLoopIterations: 100, maxSteerMessageLength: 4_000 };

const loopFrame = (verificationPlan: unknown) => ({
  type: "loop",
  task: "fix",
  verifyCommand: "pnpm test",
  verificationPlan,
});

/**
 * The plan a `loop` frame, a REST body, a graph node, an eval task and the
 * engine all have to agree on. Every field the engine understands is exercised,
 * because the surfaces used to validate a narrower subset each.
 */
const FULL_PLAN = [
  { id: "unit", command: "pnpm test", paths: ["src", "tests"], dependencyPaths: ["src"], cacheable: true },
  { id: "lint", command: "pnpm lint", required: false, timeoutMs: 60_000, dependsOn: ["unit"] },
  { id: "e2e", command: "pnpm e2e", parallel: true, resources: ["browser"], dependsOn: ["unit", "lint"] },
];

/** Plans no surface may accept, and the fragment each failure reports. */
const REJECTED: Array<[string, unknown, RegExp]> = [
  ["an empty plan", [], /1 to 16 stages/],
  [
    "more stages than the ceiling",
    Array.from({ length: MAX_LOOP_VERIFICATION_STAGES + 1 }, (_, i) => ({ id: `s${i}`, command: "true" })),
    /1 to 16 stages/,
  ],
  ["a sparse array", Object.assign([], { 1: { id: "a", command: "true" }, length: 2 }), /1 to 16 stages/],
  [
    "a duplicate stage id",
    [
      { id: "a", command: "x" },
      { id: "a", command: "y" },
    ],
    /unique safe stage id/,
  ],
  ["a blank command", [{ id: "a", command: "  " }], /bounded command/],
  ["duplicate path prefixes", [{ id: "a", command: "true", paths: ["src", "src"] }], /unique prefixes/],
  ["an escaping path prefix", [{ id: "a", command: "true", paths: ["../out"] }], /invalid relative prefix/],
  ["a NUL in a path prefix", [{ id: "a", command: "true", paths: ["sr\0c"] }], /invalid relative prefix/],
  [
    "dependencyPaths outside paths",
    [{ id: "a", command: "true", paths: ["src"], dependencyPaths: ["docs"] }],
    /subset of paths/,
  ],
  ["an unknown dependency", [{ id: "a", command: "true", dependsOn: ["ghost"] }], /depends on an unknown stage/],
  [
    "a dependency cycle",
    [
      { id: "a", command: "true", dependsOn: ["b"] },
      { id: "b", command: "true", dependsOn: ["a"] },
    ],
    /stage dependency cycle/,
  ],
  ["an unsafe resource name", [{ id: "a", command: "true", resources: ["not a name"] }], /unique safe names/],
  ["parallel without resources", [{ id: "a", command: "true", parallel: true }], /parallel requires resources/],
  [
    "a timeout no timer can represent",
    [{ id: "a", command: "true", timeoutMs: MAX_LOOP_TIMEOUT_MS + 1 }],
    /timeoutMs must be an integer from 1 to/,
  ],
];

describe("Loop verification plan contract (shared owner)", () => {
  for (const [what, plan, message] of REJECTED) {
    it(`rejects ${what} in the parser and in the loop frame`, () => {
      expect(() => parseLoopVerificationPlan(plan, { label: "plan" })).toThrow(message);
      expect(parseClientFrame(loopFrame(plan), limits)).toMatchObject({
        ok: false,
        error: expect.stringMatching(message),
      });
    });
  }

  it("accepts every field the engine understands, on both sides", () => {
    expect(parseLoopVerificationPlan(FULL_PLAN, { label: "plan" }).map((stage) => stage.id)).toEqual([
      "unit",
      "lint",
      "e2e",
    ]);
    expect(parseClientFrame(loopFrame(FULL_PLAN), limits)).toMatchObject({ ok: true });
  });

  it("keeps the accepted frame verbatim rather than the normalized stages", () => {
    const frame = loopFrame(FULL_PLAN);
    expect(parseClientFrame(frame, limits)).toMatchObject({ ok: true, frame });
  });

  it("treats a loop frame as authored text: an unknown stage field is fatal", () => {
    // A frame is not replayed state. Dropping a field the client declared would
    // start a run whose plan is quietly not the one that was requested.
    const plan = [{ id: "a", command: "true", futureField: 1 }];
    expect(parseClientFrame(loopFrame(plan), limits)).toMatchObject({
      ok: false,
      error: expect.stringContaining("unsupported field: futureField"),
    });
    expect(() => parseLoopVerificationPlan(plan, { label: "plan" })).not.toThrow();
  });

  describe("path prefixes", () => {
    it.each(["src", "src/", "./src", "apps/cli/**", "a\\b"])("accepts %j", (value) => {
      expect(isVerificationPathPrefix(value)).toBe(true);
    });

    it.each(["", "/etc", "../out", "src/../etc", "C:/tmp", "sr\0c", "x".repeat(513)])("rejects %j", (value) => {
      expect(isVerificationPathPrefix(value)).toBe(false);
    });

    it("collapses the forms that select the same tree", () => {
      expect(normalizeVerificationPath("./src/")).toBe("src");
      expect(normalizeVerificationPath("apps/cli/**")).toBe("apps/cli");
      expect(normalizeVerificationPath("a\\b")).toBe("a/b");
    });
  });
});

describe("a replayed plan is repaired, never silently discarded", () => {
  /**
   * `loop-state.ts` decodes resume state and returns null on a malformed plan —
   * "this Loop has no verification plan", which on resume is a silent behaviour
   * change rather than an error. It used to carry its own copy of these rules
   * (the sixth), so every shape that copy accepted must still decode through the
   * owner, or a checkpoint in the field quietly loses its plan.
   */
  const replay = (stage: Record<string, unknown>) =>
    parseLoopVerificationPlan([{ id: "a", command: "true", ...stage }], {
      label: "Loop verificationPlan",
      replayed: true,
    });

  it("repairs the shapes an older build could have written", () => {
    expect(replay({ paths: ["src/", "src/"] })).toEqual([{ id: "a", command: "true", paths: ["src/"] }]);
    expect(replay({ required: 1 })).toEqual([{ id: "a", command: "true" }]);
  });

  it("still refuses a stage that cannot run at all", () => {
    expect(() => parseLoopVerificationPlan([{ id: "a", command: "" }], { label: "L", replayed: true })).toThrow(
      /bounded command/,
    );
  });

  it("keeps authored text strict about the same shapes", () => {
    const authored = (stage: Record<string, unknown>) =>
      parseLoopVerificationPlan([{ id: "a", command: "true", ...stage }], { label: "L" });
    expect(() => authored({ paths: ["src/", "src/"] })).toThrow(/unique prefixes/);
    expect(() => authored({ required: 1 })).toThrow(/required must be boolean/);
  });

  it("rejects an empty resources list on both paths, as the retired copy did", () => {
    // Reported as drift in the retired copy; it was not. That copy returned null
    // on `resources.length === 0` too, so relaxing it here would have been a
    // behaviour change invented to fix a difference that did not exist.
    for (const rules of [{ label: "L" }, { label: "L", replayed: true }]) {
      expect(() =>
        parseLoopVerificationPlan([{ id: "a", command: "true", parallel: true, resources: [] }], rules),
      ).toThrow(/resources must be unique safe names/);
    }
  });
});
