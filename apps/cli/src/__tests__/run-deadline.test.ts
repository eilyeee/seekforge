import assert from "node:assert/strict";
import { test } from "vitest";
import { elapsedSeconds, resolveDurationBudgetMs } from "../run-deadline.js";
import { buildDockerRunArgs, formatDockerCommand } from "../docker-runner.js";
import { buildSshRunArgs } from "../ssh-runner.js";

// The wall-clock budget: the one cap that has to fire while nothing is
// happening, which is why it resolves to a timer duration rather than a
// predicate over run events.

test("the flag wins over the config default", () => {
  assert.equal(resolveDurationBudgetMs(30, 900), 30_000);
  assert.equal(resolveDurationBudgetMs(undefined, 900), 900_000);
});

test("no budget configured means no deadline", () => {
  assert.equal(resolveDurationBudgetMs(undefined, undefined), undefined);
});

test("a non-positive budget is 'no budget', not an instant stop", () => {
  // Same reading the cost budget gives a zero. An instant abort would be a
  // surprising way to interpret `--max-duration 0`.
  assert.equal(resolveDurationBudgetMs(0, undefined), undefined);
  assert.equal(resolveDurationBudgetMs(-5, undefined), undefined);
});

test("a non-numeric config value cannot become a deadline", () => {
  // run.ts fails fast on this before we get here; the helper must not invent a
  // budget either way.
  assert.equal(resolveDurationBudgetMs(undefined, Number.NaN), undefined);
  assert.equal(resolveDurationBudgetMs(undefined, Number.POSITIVE_INFINITY), undefined);
});

test("sub-second budgets round to whole milliseconds", () => {
  assert.equal(resolveDurationBudgetMs(1.5, undefined), 1500);
  assert.equal(resolveDurationBudgetMs(0.0004, undefined), 0);
});

test("elapsed is reported to a tenth of a second", () => {
  assert.equal(elapsedSeconds(1_000, 61_450), "60.5");
});

// The budget has to reach the run that actually spends the time. A launcher
// waiting on a container cannot enforce it from outside: a container that
// stops answering is precisely the case the timer exists for.
test("docker runner carries the budget into the in-container run", () => {
  const args = buildDockerRunArgs({ task: "t", workspacePath: "/w", maxDurationSeconds: 600 });
  assert.equal(args[args.indexOf("--max-duration") + 1], "600");
  assert.ok(!buildDockerRunArgs({ task: "t", workspacePath: "/w" }).includes("--max-duration"));
});

test("ssh runner carries the budget into the remote run, quoted", () => {
  const args = buildSshRunArgs({ task: "t", host: "me@box", workspacePath: "/w", maxDurationSeconds: 600 });
  assert.ok(args.at(-1)!.includes("--max-duration '600'"));
});

test("the printed dry-run line stays pasteable with a budget on it", () => {
  const line = formatDockerCommand(buildDockerRunArgs({ task: "t", workspacePath: "/w", maxDurationSeconds: 900 }));
  assert.ok(line.includes("--max-duration 900"));
  assert.equal(line.includes('"'), false);
});
