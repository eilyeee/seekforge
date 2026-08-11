import { existsSync, writeFileSync } from "node:fs";
import { RunManager } from "../../src/run-ledger.js";

const [workspace, worker, readyPath, goPath] = process.argv.slice(2);
if (!workspace || !worker || !readyPath || !goPath) throw new Error("missing race-worker argument");

writeFileSync(readyPath, "ready");
// Bounded: an unbounded busy-poll outlives the test that spawned it. Four of
// these were found still spinning seven days after their parent died, waiting
// on a go-file in a temp directory that had long since been removed.
const DEADLINE_MS = 60_000;
const deadline = Date.now() + DEADLINE_MS;
const wait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
while (!existsSync(goPath)) {
  if (Date.now() > deadline) throw new Error(`race worker ${worker} waited ${DEADLINE_MS}ms for ${goPath}`);
  Atomics.wait(wait, 0, 0, 5);
}

new RunManager().create({ workspace, source: "background", labels: { worker } });
