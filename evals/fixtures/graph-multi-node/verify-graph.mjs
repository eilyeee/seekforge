// Deterministic evidence about the Engineering Graph CONTROL PLANE, not the
// model's prose: read the durable checkpoint the run wrote and assert the exact
// node outcomes and dependency ordering it must have produced.
import { readFileSync } from "node:fs";

const GRAPH_ID = "eval-graph-multi-node";
const state = JSON.parse(readFileSync(`.seekforge/graphs/${GRAPH_ID}.json`, "utf8"));
const failures = [];
const expect = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

expect("graph status", state.status, "passed");
expect("node count", state.results.length, 5);

const byId = new Map(state.results.map((result) => [result.id, result]));
for (const [id, kind] of [
  ["implement", "agent"],
  ["collect-implementation", "function"],
  ["release-review", "gate"],
  ["quality", "join"],
  ["summary", "function"],
]) {
  expect(`${id} kind`, byId.get(id)?.kind, kind);
  expect(`${id} status`, byId.get(id)?.status, "passed");
}

// The single Agent node ran exactly once; a graph that re-dispatched it would
// have paid twice for the same work.
expect("implement attempts", byId.get("implement")?.attempts, 1);

// Dependency ordering is the scheduler's contract, so grade it from the
// lifecycle sequence rather than from wall-clock timestamps.
const completedAt = new Map(
  state.events.filter((event) => event.type === "node.completed").map((event) => [event.nodeId, event.sequence]),
);
for (const [before, after] of [
  ["implement", "collect-implementation"],
  ["collect-implementation", "release-review"],
  ["release-review", "summary"],
  ["quality", "summary"],
]) {
  const first = completedAt.get(before);
  const second = completedAt.get(after);
  if (typeof first !== "number" || typeof second !== "number" || first >= second) {
    failures.push(`ordering: ${before} must complete before ${after} (got ${first} then ${second})`);
  }
}

if (failures.length > 0) {
  console.error(`${GRAPH_ID} checkpoint mismatch:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`${GRAPH_ID} checkpoint OK`);
