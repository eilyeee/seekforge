import { describe, expect, it } from "vitest";
import { approveMemoryCandidate, listMemoryCandidates, rejectMemoryCandidate } from "../../src/memory/index.js";
import {
  makeCandidate,
  makeWorkspace,
  readCandidatesRaw,
  readProjectMd,
  writeCandidatesRaw,
  writeProjectMemory,
} from "./helpers.js";

function seed(ws: string, lines: unknown[]): void {
  writeCandidatesRaw(ws, lines.map((l) => `${typeof l === "string" ? l : JSON.stringify(l)}\n`).join(""));
}

describe("listMemoryCandidates", () => {
  it("returns [] when candidates.jsonl does not exist", () => {
    expect(listMemoryCandidates(makeWorkspace())).toEqual([]);
  });

  it("lists candidates newest first", () => {
    const ws = makeWorkspace();
    seed(ws, [makeCandidate({ id: "mc-s1-1", content: "older" }), makeCandidate({ id: "mc-s1-2", content: "newer" })]);
    const list = listMemoryCandidates(ws);
    expect(list.map((c) => c.id)).toEqual(["mc-s1-2", "mc-s1-1"]);
  });

  it("skips corrupt lines", () => {
    const ws = makeWorkspace();
    seed(ws, [
      makeCandidate({ id: "mc-s1-1" }),
      "{not json at all",
      '{"id": "missing-fields"}',
      makeCandidate({ id: "mc-s1-2" }),
    ]);
    const list = listMemoryCandidates(ws);
    expect(list.map((c) => c.id)).toEqual(["mc-s1-2", "mc-s1-1"]);
  });

  it("skips records with invalid numeric, timestamp, or bounded string fields", () => {
    const ws = makeWorkspace();
    const valid = makeCandidate({ id: "valid" });
    const invalid = [
      makeCandidate({ id: "" }),
      makeCandidate({ id: "x".repeat(257) }),
      makeCandidate({ id: "line\nbreak" }),
      makeCandidate({ id: "empty-content", content: "" }),
      makeCandidate({ id: "oversized-content", content: "x".repeat(16 * 1024 + 1) }),
      makeCandidate({ id: "negative-confidence", confidence: -0.1 }),
      makeCandidate({ id: "high-confidence", confidence: 1.1 }),
      makeCandidate({ id: "empty-source", sourceSessionId: "" }),
      makeCandidate({ id: "control-source", sourceSessionId: "bad\0source" }),
      makeCandidate({ id: "bad-date", createdAt: "not-a-date" }),
      makeCandidate({ id: "noncanonical-date", createdAt: "2026-06-10T08:00:00+08:00" }),
    ];
    seed(ws, [valid, ...invalid, JSON.stringify(valid).replace('"confidence":0.9', '"confidence":1e999')]);

    expect(listMemoryCandidates(ws)).toEqual([valid]);
  });
});

describe("approveMemoryCandidate", () => {
  it("marks the candidate approved and appends the fact to project.md", () => {
    const ws = makeWorkspace();
    seed(ws, [makeCandidate({ id: "mc-s1-1", content: "use pnpm", type: "command" })]);

    const updated = approveMemoryCandidate(ws, "mc-s1-1");
    expect(updated.status).toBe("approved");

    // Status persisted in the rewritten jsonl.
    expect(listMemoryCandidates(ws)[0]!.status).toBe("approved");

    // project.md created with header + bullet.
    expect(readProjectMd(ws)).toBe("# Project Memory\n- [command] use pnpm\n");
  });

  it("does not duplicate an identical content line in project.md", () => {
    const ws = makeWorkspace();
    writeProjectMemory(ws, "# Project Memory\n- [command] use pnpm\n");
    seed(ws, [makeCandidate({ id: "mc-s1-1", content: "use pnpm", type: "command" })]);

    approveMemoryCandidate(ws, "mc-s1-1");
    expect(readProjectMd(ws)).toBe("# Project Memory\n- [command] use pnpm\n");
  });

  it("appends to an existing project.md", () => {
    const ws = makeWorkspace();
    writeProjectMemory(ws, "# Project Memory\n- [tech] uses vitest\n");
    seed(ws, [makeCandidate({ id: "mc-s1-1", content: "use pnpm", type: "command" })]);

    approveMemoryCandidate(ws, "mc-s1-1");
    expect(readProjectMd(ws)).toBe("# Project Memory\n- [tech] uses vitest\n- [command] use pnpm\n");
  });

  it("throws for an unknown id", () => {
    const ws = makeWorkspace();
    seed(ws, [makeCandidate({ id: "mc-s1-1" })]);
    expect(() => approveMemoryCandidate(ws, "nope")).toThrowError("candidate not found: nope");
  });
});

describe("rejectMemoryCandidate", () => {
  it("marks the candidate rejected and does not touch project.md", () => {
    const ws = makeWorkspace();
    seed(ws, [makeCandidate({ id: "mc-s1-1" })]);

    const updated = rejectMemoryCandidate(ws, "mc-s1-1");
    expect(updated.status).toBe("rejected");
    expect(listMemoryCandidates(ws)[0]!.status).toBe("rejected");
    expect(() => readProjectMd(ws)).toThrow(); // never created
  });

  it("throws for an unknown id", () => {
    expect(() => rejectMemoryCandidate(makeWorkspace(), "ghost")).toThrowError("candidate not found: ghost");
  });

  it("only updates the matching candidate on rewrite", () => {
    const ws = makeWorkspace();
    seed(ws, [makeCandidate({ id: "mc-s1-1", content: "a" }), makeCandidate({ id: "mc-s1-2", content: "b" })]);
    rejectMemoryCandidate(ws, "mc-s1-1");
    const raw = readCandidatesRaw(ws);
    expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
    const byId = Object.fromEntries(listMemoryCandidates(ws).map((c) => [c.id, c.status]));
    expect(byId).toEqual({ "mc-s1-1": "rejected", "mc-s1-2": "pending" });
  });
});
