// Grades `--rerun`: invalidating one node must re-execute exactly that node and
// its descendants, and must leave every ancestor's settled result alone.
import { readFileSync } from "node:fs";

const GRAPH_ID = "eval-graph-rerun";
const state = JSON.parse(readFileSync(`.seekforge/graphs/${GRAPH_ID}.json`, "utf8"));
const failures = [];
const expect = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

expect("graph status", state.status, "passed");
expect("node count", state.results.length, 3);

const byId = new Map(state.results.map((result) => [result.id, result]));
for (const id of ["implement", "package", "publish"]) {
  expect(`${id} status`, byId.get(id)?.status, "passed");
}

const events = state.events;
const count = (type, nodeId) =>
  events.filter((event) => event.type === type && (nodeId === undefined || event.nodeId === nodeId)).length;

expect("graph started once", count("graph.started"), 1);
expect("graph resumed once", count("graph.resumed"), 1);

// The ancestor keeps its first result; the reran node and its descendant each
// completed twice. This is the whole point of rerun-plus-descendants.
expect("implement completed once", count("node.completed", "implement"), 1);
expect("package completed twice", count("node.completed", "package"), 2);
expect("publish completed twice", count("node.completed", "publish"), 2);

// The Agent node was never re-dispatched, so the rerun cost no provider tokens.
expect("implement attempts", byId.get("implement")?.attempts, 1);

const resumedAt = events.find((event) => event.type === "graph.resumed")?.sequence;
const implementAt = events.find((event) => event.type === "node.completed" && event.nodeId === "implement")?.sequence;
if (typeof resumedAt !== "number" || typeof implementAt !== "number" || implementAt >= resumedAt) {
  failures.push(`ordering: implement must have settled before the resume (${implementAt} vs ${resumedAt})`);
}

if (failures.length > 0) {
  console.error(`${GRAPH_ID} checkpoint mismatch:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`${GRAPH_ID} checkpoint OK`);
