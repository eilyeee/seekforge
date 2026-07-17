import * as fs from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendProjectFact,
  buildMemoryBrief,
  compactProjectMemory,
  factMetaPath,
  readFactMeta,
  readProjectMemory,
  recordFactUse,
  type MemoryCandidate,
} from "../../src/memory/index.js";
import { makeWorkspace, writeProjectMemory } from "./helpers.js";

const fact = (content: string, type: MemoryCandidate["type"] = "convention"): MemoryCandidate => ({
  id: `mc-${Math.random().toString(36).slice(2)}`,
  content,
  type,
  confidence: 0.9,
  sourceSessionId: "s1",
  createdAt: new Date().toISOString(),
  status: "approved",
});

describe("memory fact lifecycle (P2)", () => {
  it("records addedAt + uses:0 when a fact is appended to project.md", () => {
    const ws = makeWorkspace();
    appendProjectFact(ws, fact("login validation lives in src/auth.ts"));
    const meta = readFactMeta(ws);
    const key = "[convention] login validation lives in src/auth.ts";
    expect(meta[key]).toBeDefined();
    expect(meta[key]!.uses).toBe(0);
    expect(typeof meta[key]!.addedAt).toBe("string");
  });

  it("collapses newlines in a fact so project.md stays line-oriented and dedupe holds", () => {
    const ws = makeWorkspace();
    const multiline = fact("first line\nsecond line\n  third");
    appendProjectFact(ws, multiline);
    appendProjectFact(ws, multiline); // identical content must NOT re-append
    const memory = readProjectMemory(ws) ?? "";
    const bulletLines = memory.split("\n").filter((l) => l.startsWith("- ["));
    expect(bulletLines).toHaveLength(1);
    expect(bulletLines[0]).toBe("- [convention] first line second line third");
    // No orphan line: every non-empty, non-heading line is a bullet.
    for (const l of memory.split("\n")) {
      if (l.trim() === "" || l.startsWith("#")) continue;
      expect(l.startsWith("- ["), l).toBe(true);
    }
  });

  it("recordFactUse bumps uses + lastUsedAt for every fact in an injected brief", () => {
    const ws = makeWorkspace();
    appendProjectFact(ws, fact("login validation lives in src/auth.ts"));
    const brief = buildMemoryBrief(ws, "fix login validation in src/auth.ts");
    expect(brief).toBeDefined();
    recordFactUse(ws, brief!);
    recordFactUse(ws, brief!);
    const meta = readFactMeta(ws)["[convention] login validation lives in src/auth.ts"]!;
    expect(meta.uses).toBe(2);
    expect(meta.lastUsedAt).toBeDefined();
  });

  it("compact pruneUnusedDays archives old, never-used facts; keeps recent/used ones", () => {
    const ws = makeWorkspace();
    writeProjectMemory(
      ws,
      [
        "# Project Memory",
        "- [convention] ancient unused rule about widget layouts",
        "- [command] verify with pnpm test",
        "",
      ].join("\n"),
    );
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    fs.writeFileSync(
      factMetaPath(ws),
      JSON.stringify({
        "[convention] ancient unused rule about widget layouts": { addedAt: old, uses: 0 },
        "[command] verify with pnpm test": { addedAt: old, uses: 5, lastUsedAt: now },
      }),
      "utf8",
    );

    const res = compactProjectMemory(ws, { pruneUnusedDays: 90 });
    expect(res.archived).toContain("- [convention] ancient unused rule about widget layouts");

    const after = readProjectMemory(ws)!;
    expect(after).not.toContain("ancient unused rule"); // pruned (old + uses 0)
    expect(after).toContain("verify with pnpm test"); // kept (used)

    const archive = fs.readFileSync(join(ws, ".seekforge", "memory", "project-archive.md"), "utf8");
    expect(archive).toContain("ancient unused rule");
  });

  it("keeps stale facts in project.md when the archive write fails", () => {
    const ws = makeWorkspace();
    const fact = "[convention] ancient fact must not be lost";
    writeProjectMemory(ws, `# Project Memory\n- ${fact}\n`);
    fs.writeFileSync(
      factMetaPath(ws),
      JSON.stringify({ [fact]: { addedAt: "2000-01-01T00:00:00.000Z", uses: 0 } }),
      "utf8",
    );
    fs.mkdirSync(join(ws, ".seekforge", "memory", "project-archive.md"));

    const res = compactProjectMemory(ws, { pruneUnusedDays: 1 });
    expect(res.archived).toEqual([]);
    expect(readProjectMemory(ws)).toContain(fact);
  });

  it("pruneUnusedDays leaves facts without metadata untouched (unknown age)", () => {
    const ws = makeWorkspace();
    writeProjectMemory(ws, "# Project Memory\n- [convention] rule with no metadata at all\n");
    const res = compactProjectMemory(ws, { pruneUnusedDays: 1 });
    expect(res.archived).toHaveLength(0);
    expect(readProjectMemory(ws)).toContain("rule with no metadata");
  });

  it("compact that removes a near-dup drops the dropped fact's orphaned meta; keeps survivors", () => {
    const ws = makeWorkspace();
    // The shorter bullet is merged away into the longer one (near-duplicate).
    const dropped = "- [convention] run the full test suite before commit";
    const kept = "- [convention] run the full test suite before commit always";
    const survivor = "- [path] src/index.ts is the entrypoint";
    writeProjectMemory(ws, ["# Project Memory", dropped, kept, survivor, ""].join("\n"));
    const now = new Date().toISOString();
    fs.writeFileSync(
      factMetaPath(ws),
      JSON.stringify({
        "[convention] run the full test suite before commit": { addedAt: now, uses: 2 },
        "[convention] run the full test suite before commit always": { addedAt: now, uses: 4 },
        "[path] src/index.ts is the entrypoint": { addedAt: now, uses: 1 },
      }),
      "utf8",
    );

    const res = compactProjectMemory(ws);
    expect(res.merged).toHaveLength(1);

    const meta = readFactMeta(ws);
    // The dropped near-duplicate's bullet no longer exists → its meta is orphaned and removed.
    expect(meta["[convention] run the full test suite before commit"]).toBeUndefined();
    // The kept (longer) bullet and the unrelated survivor keep their meta.
    expect(meta["[convention] run the full test suite before commit always"]).toBeDefined();
    expect(meta["[convention] run the full test suite before commit always"]!.uses).toBe(4);
    expect(meta["[path] src/index.ts is the entrypoint"]).toBeDefined();
  });
});
