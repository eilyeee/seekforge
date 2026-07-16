import { describe, expect, it } from "vitest";
import {
  clampIndex,
  formatCandidateLine,
  moveCandidateIndex,
  pendingCandidates,
  removeCandidateAt,
} from "../memory-candidates.js";

describe("pendingCandidates", () => {
  it("keeps only pending candidates", () => {
    const list = [
      { id: "a", status: "pending" as const },
      { id: "b", status: "approved" as const },
      { id: "c", status: "rejected" as const },
      { id: "d", status: "pending" as const },
    ];
    expect(pendingCandidates(list).map((c) => c.id)).toEqual(["a", "d"]);
  });

  it("returns an empty array when nothing is pending", () => {
    expect(pendingCandidates([{ id: "a", status: "approved" as const }])).toEqual([]);
    expect(pendingCandidates([])).toEqual([]);
  });
});

describe("clampIndex", () => {
  it("returns 0 for an empty list", () => {
    expect(clampIndex(0, 0)).toBe(0);
    expect(clampIndex(3, 0)).toBe(0);
    expect(clampIndex(-2, 0)).toBe(0);
  });

  it("clamps below and above the range without wrapping", () => {
    expect(clampIndex(-5, 3)).toBe(0);
    expect(clampIndex(9, 3)).toBe(2);
    expect(clampIndex(1, 3)).toBe(1);
  });

  it("handles a single item", () => {
    expect(clampIndex(0, 1)).toBe(0);
    expect(clampIndex(5, 1)).toBe(0);
  });
});

describe("moveCandidateIndex", () => {
  it("returns 0 on an empty list", () => {
    expect(moveCandidateIndex(0, 1, 0)).toBe(0);
    expect(moveCandidateIndex(0, -1, 0)).toBe(0);
  });

  it("stays at 0 for a single item regardless of direction", () => {
    expect(moveCandidateIndex(0, 1, 1)).toBe(0);
    expect(moveCandidateIndex(0, -1, 1)).toBe(0);
  });

  it("wraps around both ends", () => {
    expect(moveCandidateIndex(2, 1, 3)).toBe(0); // past the end -> first
    expect(moveCandidateIndex(0, -1, 3)).toBe(2); // before the start -> last
    expect(moveCandidateIndex(1, 1, 3)).toBe(2);
  });
});

describe("removeCandidateAt", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("removes the selected item and keeps the index valid", () => {
    const r = removeCandidateAt(list, 1);
    expect(r.candidates.map((c) => c.id)).toEqual(["a", "c"]);
    expect(r.index).toBe(1);
  });

  it("clamps the index when removing the last item", () => {
    const r = removeCandidateAt(list, 2);
    expect(r.candidates.map((c) => c.id)).toEqual(["a", "b"]);
    expect(r.index).toBe(1); // was 2, clamped to new last row
  });

  it("resets to 0 when the list becomes empty", () => {
    const r = removeCandidateAt([{ id: "only" }], 0);
    expect(r.candidates).toEqual([]);
    expect(r.index).toBe(0);
  });

  it("leaves the list untouched for an out-of-range index", () => {
    const r = removeCandidateAt(list, 9);
    expect(r.candidates.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(r.index).toBe(2);
  });
});

describe("formatCandidateLine", () => {
  it("renders type, text, and a rounded confidence percentage", () => {
    expect(formatCandidateLine({ type: "command", content: "run pnpm test", confidence: 0.82 })).toBe(
      "[command] run pnpm test (82%)",
    );
  });

  it("collapses whitespace and clamps confidence into 0..100", () => {
    expect(formatCandidateLine({ type: "path", content: "  src/\n  index.ts ", confidence: 1.5 })).toBe(
      "[path] src/ index.ts (100%)",
    );
    expect(formatCandidateLine({ type: "tech", content: "x", confidence: -1 })).toBe("[tech] x (0%)");
  });

  it("coerces a non-finite confidence to 0% instead of rendering NaN%", () => {
    // Both NaN and ±Infinity are non-finite → coerced to 0 before clamping.
    expect(formatCandidateLine({ type: "tech", content: "x", confidence: NaN })).toBe("[tech] x (0%)");
    expect(formatCandidateLine({ type: "tech", content: "x", confidence: Infinity })).toBe("[tech] x (0%)");
  });
});
