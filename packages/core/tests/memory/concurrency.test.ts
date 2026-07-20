import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendProjectFact,
  approveMemoryCandidate,
  factMetaPath,
  listMemoryCandidates,
  readFactMeta,
  recordFactRetrieval,
} from "../../src/memory/index.js";
import { makeCandidate, makeWorkspace, writeCandidatesRaw } from "./helpers.js";

const children = new Set<ChildProcess>();

afterEach(() => {
  for (const child of children) child.kill("SIGTERM");
  children.clear();
});

describe("memory transaction lease", () => {
  it("serializes append, approval, and usage updates across processes", async () => {
    const workspace = makeWorkspace();
    const first = makeCandidate({ id: "mc-first", content: "shared fact", type: "tech" });
    const second = makeCandidate({ id: "mc-second", content: "peer fact", type: "path" });
    appendProjectFact(workspace, first);
    writeCandidatesRaw(workspace, `${JSON.stringify(first)}\n`);

    const storeUrl = pathToFileURL(resolve("src/memory/store.ts")).href;
    const script = `
      import * as fs from "node:fs";
      import { withMemoryTransaction, readCandidates, writeCandidates, factMetaPath } from ${JSON.stringify(storeUrl)};
      const workspace = ${JSON.stringify(workspace)};
      const second = ${JSON.stringify(second)};
      withMemoryTransaction(workspace, () => {
        const candidates = readCandidates(workspace);
        const metaFile = factMetaPath(workspace);
        const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
        fs.writeSync(1, "ready\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        candidates.push(second);
        writeCandidates(workspace, candidates);
        const key = "[tech] shared fact";
        meta[key].uses += 1;
        meta[key].retrievals = (meta[key].retrievals ?? 0) + 1;
        fs.writeFileSync(metaFile, JSON.stringify(meta), "utf8");
      });
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: resolve("../.."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    const childExit = new Promise<void>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolveExit() : reject(new Error(`memory child exited ${code}`))));
    });
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("memory lease holder did not start")), 10_000);
      child.once("error", reject);
      child.stderr?.once("data", (data) => reject(new Error(String(data))));
      child.stdout?.once("data", () => {
        clearTimeout(timer);
        resolveReady();
      });
    });

    approveMemoryCandidate(workspace, first.id);
    recordFactRetrieval(workspace, "- [tech] shared fact");
    await childExit;
    children.delete(child);

    const candidates = Object.fromEntries(
      listMemoryCandidates(workspace).map((candidate) => [candidate.id, candidate]),
    );
    expect(candidates[first.id]?.status).toBe("approved");
    expect(candidates[second.id]?.status).toBe("pending");
    const meta = readFactMeta(workspace)["[tech] shared fact"]!;
    expect(meta.uses).toBe(2);
    expect(meta.retrievals).toBe(2);
    expect(fs.readFileSync(factMetaPath(workspace), "utf8")).not.toContain("null");
  }, 20_000);
});
