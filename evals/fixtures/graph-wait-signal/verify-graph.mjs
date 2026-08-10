// Grades the durable wait: the graph must have parked on an external signal,
// and the signal delivered into the mailbox must be the thing that woke it.
import { readFileSync } from "node:fs";

const GRAPH_ID = "eval-graph-wait";
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
  ["artifact-ready", "wait"],
  ["publish", "function"],
]) {
  expect(`${id} kind`, byId.get(id)?.kind, kind);
  expect(`${id} status`, byId.get(id)?.status, "passed");
}

// The wait resolved from the delivered signal, carrying its exact payload.
const waitOutput = byId.get("artifact-ready")?.output ?? {};
expect("wait signal name", waitOutput.signal, "artifact-ready");
expect("wait payload", waitOutput.payload?.release, "1.2.3");

const events = state.events;
const count = (type, nodeId) =>
  events.filter((event) => event.type === type && (nodeId === undefined || event.nodeId === nodeId)).length;
expect("wait node parked", count("node.waiting_signal", "artifact-ready") >= 1, true);
expect("graph paused on the wait", count("graph.paused") >= 1, true);
expect("graph started once", count("graph.started"), 1);
expect("graph resumed once", count("graph.resumed"), 1);
expect("implement completed once", count("node.completed", "implement"), 1);

// A claimed signal is acknowledged and removed only after the passed wait
// result is checkpointed, so the mailbox must be empty now.
const mailbox = JSON.parse(readFileSync(`.seekforge/graphs/${GRAPH_ID}.signals.json`, "utf8"));
expect("mailbox drained", JSON.stringify(mailbox.signals), "[]");

if (failures.length > 0) {
  console.error(`${GRAPH_ID} checkpoint mismatch:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`${GRAPH_ID} checkpoint OK`);
