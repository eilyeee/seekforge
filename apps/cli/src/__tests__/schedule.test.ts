// Tests for the pure scheduled-job module (apps/cli/src/schedule.ts). Like the
// other CLI tests this is a dependency-free runner (via `tsx`): each case
// asserts with node:assert and exits non-zero on the first failure so
// `pnpm test` fails. No model/core calls and no real API spend — we only
// exercise parsing, due-calculation, validation, and the on-disk registry
// round-trip in a temp dir.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduleAddCommand, scheduleRemoveCommand, scheduleSetEnabledCommand } from "../commands/schedule.js";
import {
  addJob,
  acquireScheduleLease,
  cronMatches,
  dueJobs,
  generateId,
  isDue,
  isValidSchedule,
  loadRegistry,
  markRun,
  parseCron,
  parseInterval,
  removeJob,
  saveRegistry,
  setEnabled,
  validateJobInput,
  type Job,
} from "../schedule.js";

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  }
}

const baseJob = (over: Partial<Job> = {}): Job => ({
  id: "j1",
  task: "do a thing",
  schedule: "30m",
  mode: "ask",
  maxCostUsd: 0.5,
  enabled: true,
  ...over,
});

// --- parseInterval ----------------------------------------------------------
test("parseInterval handles s/m/h/d/w units", () => {
  assert.equal(parseInterval("45s"), 45_000);
  assert.equal(parseInterval("30m"), 30 * 60_000);
  assert.equal(parseInterval("2h"), 2 * 3_600_000);
  assert.equal(parseInterval("1d"), 86_400_000);
  assert.equal(parseInterval("1w"), 604_800_000);
});
test("parseInterval is case-insensitive and tolerates surrounding space", () => {
  assert.equal(parseInterval(" 2H "), 2 * 3_600_000);
});
test("parseInterval rejects invalid input", () => {
  for (const bad of ["", "0m", "-5m", "30", "m", "30x", "1.5h", "abc", "10 m 20s"]) {
    assert.equal(parseInterval(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});
test("parseInterval rejects unsafe counts and millisecond overflow", () => {
  assert.equal(parseInterval("9007199254740992s"), null);
  assert.equal(parseInterval("9007199254741s"), null);
  assert.equal(parseInterval("9007199254s"), 9_007_199_254_000);
});

// --- cron parsing/matching --------------------------------------------------
test("parseCron accepts a 5-field expression, rejects others", () => {
  assert.notEqual(parseCron("0 9 * * 1-5"), null);
  assert.equal(parseCron("0 9 * *"), null); // 4 fields
  assert.equal(parseCron("0 9 * * * *"), null); // 6 fields
  assert.equal(parseCron("60 9 * * *"), null); // minute out of range
  assert.equal(parseCron("*/0 * * * *"), null); // zero step
  for (const invalid of ["1x * * * *", "1-2x * * * *", "*/2x * * * *"]) {
    assert.equal(parseCron(invalid), null, invalid);
  }
});
test("cronMatches fires only at the scheduled minute", () => {
  // 09:00 on a Monday (2024-01-01 is a Monday).
  const mon0900 = new Date(2024, 0, 1, 9, 0);
  const mon0901 = new Date(2024, 0, 1, 9, 1);
  const sat0900 = new Date(2024, 0, 6, 9, 0); // Saturday
  assert.equal(cronMatches("0 9 * * 1-5", mon0900), true);
  assert.equal(cronMatches("0 9 * * 1-5", mon0901), false);
  assert.equal(cronMatches("0 9 * * 1-5", sat0900), false);
});
test("cronMatches supports */step and lists", () => {
  assert.equal(cronMatches("*/15 * * * *", new Date(2024, 0, 1, 12, 30)), true);
  assert.equal(cronMatches("*/15 * * * *", new Date(2024, 0, 1, 12, 31)), false);
  assert.equal(cronMatches("0,30 * * * *", new Date(2024, 0, 1, 12, 30)), true);
});
test("cron day-of-week accepts 7 as Sunday in ranges and steps", () => {
  const sunday = new Date(2024, 0, 7, 0, 0);
  const saturday = new Date(2024, 0, 6, 0, 0);
  assert.equal(cronMatches("0 0 * * 5-7", sunday), true);
  assert.equal(cronMatches("0 0 * * 5-7", saturday), true);
  assert.equal(cronMatches("0 0 * * */7", sunday), true);
  assert.equal(cronMatches("0 0 * * */7", saturday), false);
});
test("cron dom/dow use OR semantics when both are restricted", () => {
  // "0 0 13 * 5" → midnight on the 13th OR any Friday.
  const the13th = new Date(2024, 8, 13, 0, 0); // Sep 13 2024 is a Friday anyway
  const aFriday = new Date(2024, 0, 5, 0, 0); // Jan 5 2024, a Friday, not the 13th
  const neither = new Date(2024, 0, 6, 0, 0); // Jan 6, Saturday, not 13th
  assert.equal(cronMatches("0 0 13 * 5", the13th), true);
  assert.equal(cronMatches("0 0 13 * 5", aFriday), true);
  assert.equal(cronMatches("0 0 13 * 5", neither), false);
});

// --- isValidSchedule --------------------------------------------------------
test("isValidSchedule accepts intervals and cron, rejects junk", () => {
  assert.equal(isValidSchedule("30m"), true);
  assert.equal(isValidSchedule("0 9 * * 1-5"), true);
  assert.equal(isValidSchedule("banana"), false);
  assert.equal(isValidSchedule(""), false);
});

// --- isDue / dueJobs --------------------------------------------------------
test("interval job is due when never run", () => {
  assert.equal(isDue(baseJob({ schedule: "30m", lastRunAt: undefined }), new Date()), true);
});
test("interval job is due only after the interval elapses since lastRunAt", () => {
  const now = new Date("2024-01-01T12:00:00Z");
  const justRan = new Date("2024-01-01T11:45:00Z").toISOString(); // 15m ago
  const longAgo = new Date("2024-01-01T11:00:00Z").toISOString(); // 60m ago
  assert.equal(isDue(baseJob({ schedule: "30m", lastRunAt: justRan }), now), false);
  assert.equal(isDue(baseJob({ schedule: "30m", lastRunAt: longAgo }), now), true);
});
test("disabled jobs are never due", () => {
  assert.equal(isDue(baseJob({ enabled: false, lastRunAt: undefined }), new Date()), false);
});
test("cron job is due at the matching minute but not twice in the same minute", () => {
  const at0900 = new Date(2024, 0, 1, 9, 0, 5); // Monday 09:00:05
  const job = baseJob({ schedule: "0 9 * * 1-5", lastRunAt: undefined });
  assert.equal(isDue(job, at0900), true);
  const alreadyRan = baseJob({ schedule: "0 9 * * 1-5", lastRunAt: new Date(2024, 0, 1, 9, 0, 1).toISOString() });
  assert.equal(isDue(alreadyRan, new Date(2024, 0, 1, 9, 0, 40)), false); // same minute
});
test("dueJobs returns only enabled+due jobs", () => {
  const now = new Date("2024-01-01T12:00:00Z");
  const jobs = [
    baseJob({ id: "a", schedule: "30m", lastRunAt: undefined }), // due
    baseJob({ id: "b", schedule: "30m", lastRunAt: now.toISOString() }), // not due
    baseJob({ id: "c", schedule: "30m", enabled: false }), // disabled
  ];
  assert.deepEqual(
    dueJobs(jobs, now).map((j) => j.id),
    ["a"],
  );
});

// --- validateJobInput -------------------------------------------------------
test("validateJobInput accepts a well-formed job and defaults enabled=true", () => {
  const r = validateJobInput({ id: "nightly", task: "review diff", schedule: "1d", mode: "edit", maxCostUsd: 1 });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.job.enabled, true);
    assert.equal(r.job.mode, "edit");
  }
});
test("validateJobInput REJECTS a missing maxCostUsd (safety-critical)", () => {
  const r = validateJobInput({ id: "x", task: "t", schedule: "1h", mode: "ask" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("maxCostUsd")), r.errors.join(","));
});
test("validateJobInput rejects a non-positive maxCostUsd", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = validateJobInput({ id: "x", task: "t", schedule: "1h", mode: "ask", maxCostUsd: bad });
    assert.equal(r.ok, false, `expected reject for maxCostUsd=${bad}`);
  }
});
test("validateJobInput rejects a bad schedule, bad mode, empty id/task", () => {
  assert.equal(validateJobInput({ id: "x", task: "t", schedule: "nope", mode: "ask", maxCostUsd: 1 }).ok, false);
  assert.equal(
    validateJobInput({ id: "x", task: "t", schedule: "1h", mode: "run" as never, maxCostUsd: 1 }).ok,
    false,
  );
  assert.equal(validateJobInput({ id: "", task: "t", schedule: "1h", mode: "ask", maxCostUsd: 1 }).ok, false);
  assert.equal(validateJobInput({ id: "x", task: "", schedule: "1h", mode: "ask", maxCostUsd: 1 }).ok, false);
  assert.equal(validateJobInput({ id: "bad id", task: "t", schedule: "1h", mode: "ask", maxCostUsd: 1 }).ok, false);
});

// --- pure registry operations -----------------------------------------------
test("addJob appends and rejects duplicate ids", () => {
  const jobs = addJob([], baseJob({ id: "a" }));
  assert.equal(jobs.length, 1);
  assert.throws(() => addJob(jobs, baseJob({ id: "a" })), /already exists/);
});
test("removeJob reports whether something was removed", () => {
  const jobs = [baseJob({ id: "a" }), baseJob({ id: "b" })];
  const r1 = removeJob(jobs, "a");
  assert.equal(r1.removed, true);
  assert.deepEqual(r1.jobs.map((j) => j.id), ["b"]);
  const r2 = removeJob(jobs, "zzz");
  assert.equal(r2.removed, false);
});
test("setEnabled toggles the flag and returns the updated job", () => {
  const jobs = [baseJob({ id: "a", enabled: true })];
  const r = setEnabled(jobs, "a", false);
  assert.equal(r.job?.enabled, false);
  assert.equal(r.jobs[0]!.enabled, false);
  assert.equal(setEnabled(jobs, "missing", false).job, undefined);
});
test("markRun stamps lastRunAt only on the target job", () => {
  const at = new Date("2024-01-01T00:00:00Z");
  const jobs = markRun([baseJob({ id: "a" }), baseJob({ id: "b" })], "a", at);
  assert.equal(jobs[0]!.lastRunAt, at.toISOString());
  assert.equal(jobs[1]!.lastRunAt, undefined);
});
test("generateId derives a unique slug from the task", () => {
  const id = generateId("Review the open pull requests", []);
  assert.equal(id, "review-the-open-pull");
  const id2 = generateId("Review the open pull requests", [baseJob({ id: "review-the-open-pull" })]);
  assert.equal(id2, "review-the-open-pull-2");
});

// --- registry disk round-trip (temp dir) ------------------------------------
test("saveRegistry/loadRegistry round-trip through a temp .seekforge dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-sched-"));
  try {
    // absent file → empty registry
    assert.deepEqual(loadRegistry(dir), { jobs: [] });

    // add → list
    let reg = loadRegistry(dir);
    reg = { jobs: addJob(reg.jobs, baseJob({ id: "nightly", schedule: "1d", maxCostUsd: 0.5 })) };
    saveRegistry(dir, reg);
    assert.equal(statSync(join(dir, ".seekforge", "schedules.json")).mode & 0o777, 0o600);
    assert.deepEqual(loadRegistry(dir).jobs.map((j) => j.id), ["nightly"]);

    // enable/disable persists
    saveRegistry(dir, { jobs: setEnabled(loadRegistry(dir).jobs, "nightly", false).jobs });
    assert.equal(loadRegistry(dir).jobs[0]!.enabled, false);

    // remove persists
    saveRegistry(dir, { jobs: removeJob(loadRegistry(dir).jobs, "nightly").jobs });
    assert.deepEqual(loadRegistry(dir).jobs, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("schedule storage refuses symlinked state directories and files", () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-sched-"));
  const externalDir = mkdtempSync(join(tmpdir(), "sf-sched-external-"));
  try {
    symlinkSync(externalDir, join(dir, ".seekforge"));
    assert.throws(() => saveRegistry(dir, { jobs: [] }), /real directory/);
    assert.equal(existsSync(join(externalDir, "schedules.json")), false, "external registry must not be created");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  }

  const leafDir = mkdtempSync(join(tmpdir(), "sf-sched-"));
  const leafExternalDir = mkdtempSync(join(tmpdir(), "sf-sched-external-"));
  try {
    const stateDir = join(leafDir, ".seekforge");
    const external = join(leafExternalDir, "schedules.json");
    mkdirSync(stateDir);
    writeFileSync(external, "keep\n");
    symlinkSync(external, join(stateDir, "schedules.json"));
    assert.throws(() => saveRegistry(leafDir, { jobs: [] }), /regular file|symlink/);
    assert.equal(readFileSync(external, "utf8"), "keep\n");
    assert.deepEqual(loadRegistry(leafDir), { jobs: [] });
  } finally {
    rmSync(leafDir, { recursive: true, force: true });
    rmSync(leafExternalDir, { recursive: true, force: true });
  }
});
test("loadRegistry tolerates a corrupt/invalid file", () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-sched-"));
  try {
    saveRegistry(dir, { jobs: [] });
    // overwrite with garbage
    const file = join(dir, ".seekforge", "schedules.json");
    writeFileSync(file, "{ not json", "utf8");
    assert.deepEqual(loadRegistry(dir), { jobs: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("loadRegistry rejects persisted non-finite or non-positive budgets", () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-sched-"));
  try {
    const file = join(dir, ".seekforge", "schedules.json");
    saveRegistry(dir, { jobs: [] });
    for (const budget of ["1e999", "0", "-1"]) {
      writeFileSync(file, `{"jobs":[{"id":"x","task":"t","schedule":"1h","mode":"ask","maxCostUsd":${budget},"enabled":true}]}`);
      assert.deepEqual(loadRegistry(dir), { jobs: [] });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schedule lease excludes overlap and can be reacquired after release", () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-sched-"));
  try {
    const release = acquireScheduleLease(dir);
    assert.equal(typeof release, "function");
    assert.equal(acquireScheduleLease(dir), null);
    release!();
    const reacquired = acquireScheduleLease(dir);
    assert.equal(typeof reacquired, "function");
    reacquired!();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schedule mutation commands do not bypass an occupied scheduler lease", () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-sched-"));
  const oldExitCode = process.exitCode;
  const oldWrite = process.stderr.write;
  try {
    saveRegistry(dir, { jobs: [baseJob({ id: "existing" })] });
    const before = readFileSync(join(dir, ".seekforge", "schedules.json"), "utf8");
    const release = acquireScheduleLease(dir);
    assert.equal(typeof release, "function");
    process.stderr.write = (() => true) as typeof process.stderr.write;

    scheduleAddCommand({ task: "new job", every: "1h", maxCost: 1 }, dir);
    scheduleRemoveCommand("existing", dir);
    scheduleSetEnabledCommand("existing", false, dir);

    assert.equal(readFileSync(join(dir, ".seekforge", "schedules.json"), "utf8"), before);
    release!();
  } finally {
    process.stderr.write = oldWrite;
    process.exitCode = oldExitCode;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schedule lease recovers a lock owned by a dead process", () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-sched-"));
  try {
    const lock = join(dir, ".seekforge", "schedules.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({
      pid: 2_147_483_647,
      token: "dead-owner",
      acquiredAt: new Date(0).toISOString(),
    }));
    const release = acquireScheduleLease(dir);
    assert.equal(typeof release, "function");
    release!();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schedule lease recovers when a PID was reused by another process identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-sched-"));
  try {
    const lock = join(dir, ".seekforge", "schedules.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({
      pid: process.pid,
      token: "previous-process",
      acquiredAt: new Date(0).toISOString(),
      processIdentity: "not-the-current-process",
    }));
    const release = acquireScheduleLease(dir);
    assert.equal(typeof release, "function");
    release!();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schedule lease does not race another stale-lock recovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-sched-"));
  try {
    const lock = join(dir, ".seekforge", "schedules.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({
      pid: 2_147_483_647,
      token: "dead-owner",
      acquiredAt: new Date(0).toISOString(),
    }));
    mkdirSync(`${lock}.recovery`);

    assert.equal(acquireScheduleLease(dir), null);
    assert.equal(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token, "dead-owner");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schedule lease recovers an abandoned recovery directory after the grace period", () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-sched-"));
  try {
    const lock = join(dir, ".seekforge", "schedules.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({
      pid: 2_147_483_647,
      token: "dead-owner",
      acquiredAt: new Date(0).toISOString(),
    }));
    const recovery = `${lock}.recovery`;
    mkdirSync(recovery);
    const old = new Date(Date.now() - 60_000);
    utimesSync(recovery, old, old);

    const release = acquireScheduleLease(dir);
    assert.equal(typeof release, "function");
    release!();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`${passed} schedule tests passed`);
