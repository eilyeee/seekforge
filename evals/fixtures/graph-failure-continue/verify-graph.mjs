// Grades failurePolicy "continue": one branch fails closed, its ordinary
// dependent is skipped, and the INDEPENDENT branch still runs to completion.
import { readFileSync } from "node:fs";

const GRAPH_ID = "eval-graph-continue";
const state = JSON.parse(readFileSync(`.seekforge/graphs/${GRAPH_ID}.json`, "utf8"));
const failures = [];
const expect = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

expect("graph status", state.status, "failed");
expect("node count", state.results.length, 4);

const byId = new Map(state.results.map((result) => [result.id, result]));
for (const [id, status] of [
  ["stale-approval", "failed"],
  ["blocked-publish", "skipped"],
  ["implement", "passed"],
  ["independent-summary", "passed"],
]) {
  expect(`${id} status`, byId.get(id)?.status, status);
}

// The failure is the bounded wait deadline, not an agent or handler crash.
expect("stale-approval error", byId.get("stale-approval")?.error, "Graph wait expired");
expect("stale-approval attempts", byId.get("stale-approval")?.attempts, 0);
// A skipped dependent must not have burned an attempt either.
expect("blocked-publish attempts", byId.get("blocked-publish")?.attempts, 0);
// The independent branch really executed rather than being skipped along.
expect("implement attempts", byId.get("implement")?.attempts, 1);
expect("independent-summary attempts", byId.get("independent-summary")?.attempts, 1);

const events = state.events;
const count = (type, nodeId) =>
  events.filter((event) => event.type === type && (nodeId === undefined || event.nodeId === nodeId)).length;
expect("graph completed once", count("graph.completed"), 1);
expect("independent branch completed", count("node.completed", "independent-summary"), 1);
expect("blocked dependent was skipped", count("node.skipped", "blocked-publish"), 1);

if (failures.length > 0) {
  console.error(`${GRAPH_ID} checkpoint mismatch:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`${GRAPH_ID} checkpoint OK`);
