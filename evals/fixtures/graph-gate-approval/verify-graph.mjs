// Grades the approval lifecycle from the durable checkpoint: the graph must
// have PAUSED at the gate, and the resume must have crossed exactly that gate
// without re-dispatching the already-passed Agent ancestor.
import { readFileSync } from "node:fs";

const GRAPH_ID = "eval-graph-gate";
const state = JSON.parse(readFileSync(`.seekforge/graphs/${GRAPH_ID}.json`, "utf8"));
const failures = [];
const expect = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

expect("graph status", state.status, "passed");
expect("node count", state.results.length, 3);
expect("pauseReason cleared", state.pauseReason, undefined);

const byId = new Map(state.results.map((result) => [result.id, result]));
for (const [id, kind] of [
  ["implement", "agent"],
  ["review", "gate"],
  ["publish", "function"],
]) {
  expect(`${id} kind`, byId.get(id)?.kind, kind);
  expect(`${id} status`, byId.get(id)?.status, "passed");
}

const events = state.events;
const count = (type, nodeId) =>
  events.filter((event) => event.type === type && (nodeId === undefined || event.nodeId === nodeId)).length;

// The gate really blocked, and the second invocation really was a resume.
expect("review waited for approval", count("node.waiting_approval", "review") >= 1, true);
expect("graph paused at the gate", count("graph.paused") >= 1, true);
expect("graph resumed", count("graph.resumed"), 1);
expect("graph started once", count("graph.started"), 1);

// Ancestors are not replayed by a resume: exactly one completion for the Agent.
expect("implement completed once", count("node.completed", "implement"), 1);
expect("implement attempts", byId.get("implement")?.attempts, 1);

// Post-gate work happened after the resume, not before the approval.
const resumedAt = events.find((event) => event.type === "graph.resumed")?.sequence;
const publishedAt = events.find((event) => event.type === "node.completed" && event.nodeId === "publish")?.sequence;
if (typeof resumedAt !== "number" || typeof publishedAt !== "number" || publishedAt <= resumedAt) {
  failures.push(`ordering: publish must complete after the resume (resumed ${resumedAt}, published ${publishedAt})`);
}

if (failures.length > 0) {
  console.error(`${GRAPH_ID} checkpoint mismatch:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`${GRAPH_ID} checkpoint OK`);
