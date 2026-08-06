import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../../src/util/workspace-state.js";

/**
 * `durable: false` controls the fsyncs, not the atomicity.
 *
 * The distinction matters because the fsyncs are the expensive part — two per
 * write, tens of milliseconds each — and a file the code calls observability
 * does not need them: losing the last few forecast samples to a power cut costs
 * a worse forecast and nothing else. What it must NOT lose is the temp-file +
 * rename, or a reader could see half a file at any time, crash or no crash.
 */

function workspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "seekforge-state-"));
  mkdirSync(join(ws, ".seekforge"), { recursive: true });
  return ws;
}

const REL = ".seekforge/observability.json";

describe("writeWorkspaceStateFileAtomic durability", () => {
  it("writes the same bytes either way", () => {
    const durable = workspace();
    const fast = workspace();
    writeWorkspaceStateFileAtomic(durable, REL, '{"a":1}');
    writeWorkspaceStateFileAtomic(fast, REL, '{"a":1}', { durable: false });
    expect(readWorkspaceStateFile(durable, REL, 1024)).toBe('{"a":1}');
    expect(readWorkspaceStateFile(fast, REL, 1024)).toBe('{"a":1}');
  });

  it("still replaces atomically, leaving no temp file behind", () => {
    const ws = workspace();
    writeWorkspaceStateFileAtomic(ws, REL, "first", { durable: false });
    writeWorkspaceStateFileAtomic(ws, REL, "second", { durable: false });
    // A reader that opened the path at any moment saw one whole version or the
    // other — never a partially written file, which is what the rename buys and
    // what dropping the fsync must not cost.
    expect(readWorkspaceStateFile(ws, REL, 1024)).toBe("second");
    expect(readFileSync(join(ws, REL), "utf8")).toBe("second");
    // And the temp file the rename came from is gone — the half of "atomically"
    // this test's name claims and used not to check.
    expect(readdirSync(join(ws, ".seekforge")).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("defaults to durable, so a checkpoint cannot become fast by omission", () => {
    // The risky direction is a caller that forgets the option and silently gets
    // the weaker guarantee. The default is the strong one; opting out is
    // explicit and belongs where the file's meaning is documented.
    const ws = workspace();
    expect(() => writeWorkspaceStateFileAtomic(ws, REL, "x")).not.toThrow();
    expect(readWorkspaceStateFile(ws, REL, 1024)).toBe("x");
  });

  it("keeps refusing a path outside the workspace either way", () => {
    const ws = workspace();
    for (const opts of [{}, { durable: false }]) {
      expect(() => writeWorkspaceStateFileAtomic(ws, "../escape.json", "x", opts)).toThrow();
    }
  });

  it("keeps refusing a symlinked target either way", () => {
    const ws = workspace();
    const outside = join(tmpdir(), `seekforge-outside-${process.pid}.json`);
    writeFileSync(outside, "not yours");
    symlinkSync(outside, join(ws, REL));
    for (const opts of [{}, { durable: false }]) {
      expect(() => writeWorkspaceStateFileAtomic(ws, REL, "x", opts)).toThrow();
    }
    expect(readFileSync(outside, "utf8")).toBe("not yours");
  });
});
