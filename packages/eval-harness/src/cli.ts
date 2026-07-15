/**
 * Eval CLI:
 *   pnpm --filter @seekforge/eval-harness eval [-- <options>]
 *
 * Options:
 *   --task <id>            Run only this task.
 *   --suite <name>         Select a suite from evals/config.json.
 *   --repeat <count>       Override the suite sample count (positive integer).
 *   --junit <file>         Write JUnit XML for CI test reporting.
 *   --require-api-key      Fail instead of skipping when no provider API key exists.
 *   --baseline <file>      Compare results against a previous report .json.
 *   --fail-on-regression   With --baseline: exit 1 on a task-level pass→fail;
 *                          selected suite gates are also enforced.
 *   --keep                 Keep the throwaway workspaces for debugging.
 *   --variant <name>       Run under one named variant (see variants.ts).
 *                          Default: control; use --ab to compare two.
 *   --ab <a,b>             Run the FULL task set under variant a and variant b
 *                          and print a comparison table; writes ab-<ts>.json.
 *   --skill-ranking        Append a skill-effectiveness ranking section.
 *   --list-variants        Print the variant registry and exit.
 *
 * Exits 0 with a skip message when no API key is configured unless
 * --require-api-key is set; exits 1 when any task failed.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "./args.js";
import { aggregateResults } from "./aggregate.js";
import { toAbJson, toAbMarkdown, compareVariants, type VariantRun } from "./ab.js";
import { createDefaultAgentFactory } from "./agent-factory.js";
import { loadEvalConfig } from "./config.js";
import { evaluateGates, type GateResult } from "./gates.js";
import { writeJunit } from "./junit.js";
import { fixturesDir, reportsDir, tasksDir } from "./paths.js";
import { compare, regressions, toMarkdown, writeReport } from "./report.js";
import { createRunMetadata } from "./run-metadata.js";
import { rankSkills, toSkillRankingMarkdown } from "./skill-ranking.js";
import { assertFixturesExist, loadTasks, type TaskDef } from "./tasks.js";
import { runTask, type TaskResult } from "./task-runner.js";
import { loadSuiteConfig, selectSuite, type SuiteConfig } from "./suite-config.js";
import { getVariant, listVariants } from "./variants.js";

/** Runs every task under one named variant, printing per-task progress. */
async function runVariant(
  variantName: string,
  tasks: TaskDef[],
  config: ReturnType<typeof loadEvalConfig>,
  keepDir: boolean,
  repeat: number,
): Promise<TaskResult[]> {
  const variant = getVariant(variantName);
  const options = variant.apply({});
  const createAgent = createDefaultAgentFactory(config, options);
  const results: TaskResult[] = [];
  for (let sample = 1; sample <= repeat; sample++) {
    for (const task of tasks) {
      const sampleLabel = repeat > 1 ? ` sample ${sample}/${repeat}` : "";
      console.log(`▶ [${variantName}] ${task.id}${sampleLabel}: ${task.title}`);
      const result = await runTask(task, { createAgent, keepDir, taskSuffix: options.taskSuffix });
      if (repeat > 1) result.sample = sample;
      const passed = result.checks.filter((c) => c.passed).length;
      console.log(`  ${result.success ? "✓ pass" : "✗ fail"} (${passed}/${result.checks.length} checks)`);
      for (const check of result.checks) {
        if (!check.passed) console.log(`    ✗ ${check.check.type}: ${check.detail ?? "failed"}`);
      }
      if (result.error) console.log(`    session error: ${result.error}`);
      if (result.workspaceDir) console.log(`    workspace kept: ${result.workspaceDir}`);
      results.push(result);
    }
  }
  return results;
}

function writeAbReport(runs: VariantRun[], summary: ReturnType<typeof compareVariants>): string {
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(reportsDir, `ab-${stamp}.json`);
  writeFileSync(jsonPath, toAbJson(runs, summary));
  return jsonPath;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.listVariants) {
    console.log("Available variants:");
    for (const v of listVariants()) console.log(`  ${v.name}: ${v.describe}`);
    return;
  }

  let tasks = loadTasks(tasksDir);
  assertFixturesExist(tasks, fixturesDir);
  let suite: SuiteConfig | undefined;
  if (args.suite !== undefined) {
    suite = selectSuite(loadSuiteConfig(), args.suite);
    if (suite.tasks !== "*") {
      const requested = new Set(suite.tasks);
      const known = new Set(tasks.map((task) => task.id));
      const missing = suite.tasks.filter((id) => !known.has(id));
      if (missing.length > 0) throw new Error(`suite ${args.suite} references unknown tasks: ${missing.join(", ")}`);
      tasks = tasks.filter((task) => requested.has(task.id));
    }
  }
  if (args.taskId !== undefined) {
    // --task accepts one id or a comma-separated list (run a chosen subset).
    const ids = new Set(args.taskId.split(",").map((s) => s.trim()).filter(Boolean));
    const known = new Set(tasks.map((task) => task.id));
    const missing = [...ids].filter((id) => !known.has(id));
    if (ids.size === 0 || missing.length > 0) {
      console.error(`error: unknown task id(s): ${(missing.length > 0 ? missing : [args.taskId]).join(", ")}`);
      process.exitCode = 1;
      return;
    }
    tasks = tasks.filter((t) => ids.has(t.id));
  }

  const config = loadEvalConfig();
  if (!config.apiKey) {
    const message = "No provider API key found in the provider-specific environment variable or .seekforge/config.json";
    if (args.requireApiKey) throw new Error(`${message}; --require-api-key forbids skipping evals.`);
    console.log(`${message}; skipping evals.`);
    return; // exit 0: skipping is not a failure
  }
  const repeat = args.repeat ?? suite?.repeat ?? 1;

  // --ab: run the full set under two variants and compare.
  if (args.ab) {
    if (repeat !== 1) {
      throw new Error("multi-sample --repeat is not supported with --ab; run each variant separately");
    }
    const [nameA, nameB] = args.ab;
    const resultsA = await runVariant(nameA, tasks, config, args.keep, repeat);
    const resultsB = await runVariant(nameB, tasks, config, args.keep, repeat);
    const runs: VariantRun[] = [
      { variant: nameA, results: resultsA },
      { variant: nameB, results: resultsB },
    ];
    const summary = compareVariants(runs[0]!, runs[1]!);
    console.log(`\n${toAbMarkdown(summary)}`);
    if (args.skillRanking) {
      console.log(`\n${toSkillRankingMarkdown(rankSkills([...resultsA, ...resultsB]))}`);
    }
    const jsonPath = writeAbReport(runs, summary);
    console.log(`\nA/B report written:\n  ${jsonPath}`);
    if ([...resultsA, ...resultsB].some((r) => !r.success)) process.exitCode = 1;
    return;
  }

  // Single run, under the requested variant (default control).
  const variantName = args.variants[0] ?? "control";
  const results = await runVariant(variantName, tasks, config, args.keep, repeat);

  console.log(`\n${toMarkdown(results)}`);
  let regressed: string[] = [];
  let baselineJson: string | undefined;
  if (args.baseline !== undefined) {
    baselineJson = readFileSync(args.baseline, "utf8");
    console.log(`\nComparison vs baseline:\n${compare(results, baselineJson)}`);
    regressed = regressions(results, baselineJson);
  }
  if (args.skillRanking) {
    console.log(`\n${toSkillRankingMarkdown(rankSkills(results))}`);
  }

  let gateResult: GateResult | undefined;
  if (suite !== undefined) {
    gateResult = evaluateGates(results, suite.gates, baselineJson);
    console.log("\nSuite gates:");
    for (const gate of gateResult.checks) console.log(`  ${gate.passed ? "✓" : "✗"} ${gate.message}`);
  }
  const variant = getVariant(variantName);
  const variantOptions = variant.apply({});
  const metadata = createRunMetadata({
    config,
    variant: variantName,
    suite: args.suite,
    repeat,
    tasks,
    fixtureRoot: fixturesDir,
    modelOverride: variantOptions.model,
  });
  const { markdownPath, jsonPath } = writeReport(results, reportsDir, {
    metadata,
    aggregate: aggregateResults(results),
    ...(gateResult ? { gates: gateResult } : {}),
  });
  if (args.junit !== undefined) writeJunit(results, args.junit, `SeekForge ${args.suite ?? "eval"}`);
  console.log(`\nReport written:\n  ${markdownPath}\n  ${jsonPath}`);
  if (args.junit !== undefined) console.log(`  ${args.junit}`);

  // --fail-on-regression: the gate fails ONLY on a pass→fail vs the baseline
  // (a known-red/flaky task stays non-blocking). Without it, any absolute
  // failure fails the run (the default local behavior).
  if (args.failOnRegression) {
    if (regressed.length > 0 || gateResult?.passed === false) {
      if (regressed.length > 0) {
        console.error(`\n✗ ${regressed.length} regression(s) vs baseline: ${regressed.join(", ")}`);
      }
      if (gateResult?.passed === false) console.error("\n✗ one or more suite gates failed");
      process.exitCode = 1;
    } else {
      console.log("\n✓ no regressions vs baseline");
    }
  } else if (results.some((r) => !r.success) || gateResult?.passed === false) {
    if (gateResult?.passed === false) console.error("\n✗ one or more suite gates failed");
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
