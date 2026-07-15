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
 *   --ab <a,b>             Run paired samples under variants a and b, alternating
 *                          arm order; writes ab-<ts>.json/.md.
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
import { alternatingArmOrder, toAbJson, toAbMarkdown, compareVariants, type VariantRun } from "./ab.js";
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
import { writeTrendReport } from "./trends.js";
import { loadSuiteConfig, selectSuite, type SuiteConfig } from "./suite-config.js";
import { getVariant, listVariants, type AgentBuildOptions } from "./variants.js";

type VariantExecutor = {
  name: string;
  options: AgentBuildOptions;
  createAgent: ReturnType<typeof createDefaultAgentFactory>;
};

function variantExecutor(
  name: string,
  config: ReturnType<typeof loadEvalConfig>,
): VariantExecutor {
  const options = getVariant(name).apply({});
  return { name, options, createAgent: createDefaultAgentFactory(config, options) };
}

async function runOne(
  executor: VariantExecutor,
  task: TaskDef,
  keepDir: boolean,
  sample: number,
  repeat: number,
): Promise<TaskResult> {
  const sampleLabel = repeat > 1 ? ` sample ${sample}/${repeat}` : "";
  console.log(`> [${executor.name}] ${task.id}${sampleLabel}: ${task.title}`);
  const result = await runTask(task, {
    createAgent: executor.createAgent,
    keepDir,
    taskSuffix: executor.options.taskSuffix,
  });
  if (repeat > 1) result.sample = sample;
  const passed = result.checks.filter((check) => check.passed).length;
  console.log(`  ${result.success ? "PASS" : "FAIL"} (${passed}/${result.checks.length} checks)`);
  for (const check of result.checks) {
    if (!check.passed) console.log(`    FAIL ${check.check.type}: ${check.detail ?? "failed"}`);
  }
  if (!result.execution?.passed) {
    console.log(
      `    terminal: ${result.execution?.status ?? "unknown"} ` +
      `(expected ${result.execution?.expectedStatus ?? "completed"})`,
    );
  }
  if (result.error) console.log(`    session error: ${result.error}`);
  if (result.workspaceDir) console.log(`    workspace kept: ${result.workspaceDir}`);
  return result;
}

/** Runs every task under one named variant, printing per-task progress. */
async function runVariant(
  variantName: string,
  tasks: TaskDef[],
  config: ReturnType<typeof loadEvalConfig>,
  keepDir: boolean,
  repeat: number,
): Promise<TaskResult[]> {
  const executor = variantExecutor(variantName, config);
  const results: TaskResult[] = [];
  for (let sample = 1; sample <= repeat; sample++) {
    for (const task of tasks) {
      results.push(await runOne(executor, task, keepDir, sample, repeat));
    }
  }
  return results;
}

/** Alternates arm order within every exact task/sample pair. */
async function runAbVariants(
  names: [string, string],
  tasks: TaskDef[],
  config: ReturnType<typeof loadEvalConfig>,
  keepDir: boolean,
  repeat: number,
): Promise<VariantRun[]> {
  const a = variantExecutor(names[0], config);
  const b = variantExecutor(names[1], config);
  const resultsA: TaskResult[] = [];
  const resultsB: TaskResult[] = [];
  let pairIndex = 0;
  for (let sample = 1; sample <= repeat; sample++) {
    for (const task of tasks) {
      const order = alternatingArmOrder(pairIndex++).map((arm) => arm === "a" ? a : b);
      for (const executor of order) {
        const result = await runOne(executor, task, keepDir, sample, repeat);
        (executor === a ? resultsA : resultsB).push(result);
      }
    }
  }
  return [
    { variant: a.name, results: resultsA },
    { variant: b.name, results: resultsB },
  ];
}

function writeAbReport(
  runs: VariantRun[],
  summary: ReturnType<typeof compareVariants>,
): { jsonPath: string; markdownPath: string } {
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(reportsDir, `ab-${stamp}.json`);
  const markdownPath = join(reportsDir, `ab-${stamp}.md`);
  writeFileSync(jsonPath, toAbJson(runs, summary));
  writeFileSync(markdownPath, `# SeekForge paired A/B report\n\n${toAbMarkdown(summary)}\n`);
  return { jsonPath, markdownPath };
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
    const [nameA, nameB] = args.ab;
    const runs = await runAbVariants([nameA, nameB], tasks, config, args.keep, repeat);
    const resultsA = runs[0]!.results;
    const resultsB = runs[1]!.results;
    const summary = compareVariants(runs[0]!, runs[1]!);
    console.log(`\n${toAbMarkdown(summary)}`);
    if (args.skillRanking) {
      console.log(`\n${toSkillRankingMarkdown(rankSkills([...resultsA, ...resultsB]))}`);
    }
    const { jsonPath, markdownPath } = writeAbReport(runs, summary);
    const trends = writeTrendReport(reportsDir);
    console.log(`\nA/B report written:\n  ${markdownPath}\n  ${jsonPath}\n  ${trends.markdownPath}\n  ${trends.jsonPath}`);
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
  const trends = writeTrendReport(reportsDir);
  if (args.junit !== undefined) writeJunit(results, args.junit, `SeekForge ${args.suite ?? "eval"}`);
  console.log(`\nReport written:\n  ${markdownPath}\n  ${jsonPath}\n  ${trends.markdownPath}\n  ${trends.jsonPath}`);
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
