import { existsSync, writeFileSync } from "node:fs";
import { RunManager } from "../../src/run-ledger.js";

const [workspace, worker, readyPath, goPath] = process.argv.slice(2);
if (!workspace || !worker || !readyPath || !goPath) throw new Error("missing race-worker argument");

writeFileSync(readyPath, "ready");
const wait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
while (!existsSync(goPath)) Atomics.wait(wait, 0, 0, 5);

new RunManager().create({ workspace, source: "background", labels: { worker } });
