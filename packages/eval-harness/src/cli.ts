/**
 * Eval CLI:
 *   pnpm --filter @seekforge/eval-harness eval [-- <options>]
 *
 * Options:
 *   --task <id>            Run only this task.
 *   --baseline <file>      Compare results against a previous report .json.
 *   --keep                 Keep the throwaway workspaces for debugging.
 *   --variant <name>       Run under a single named variant (repeatable; see
 *                          variants.ts). Default: control.
 *   --ab <a,b>             Run the FULL task set under variant a and variant b
 *                          and print a comparison table; writes ab-<ts>.json.
 *   --skill-ranking        Append a skill-effectiveness ranking section.
 *   --list-variants        Print the variant registry and exit.
 *
 * Exits 0 with a skip message when no API key is configured; exits 1 when
 * any task failed.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toAbJson, toAbMarkdown, compareVariants, type VariantRun } from "./ab.js";
import { createDefaultAgentFactory } from "./agent-factory.js";
import { loadEvalConfig } from "./config.js";
import { fixturesDir, reportsDir, tasksDir } from "./paths.js";
import { compare, toMarkdown, writeReport } from "./report.js";
import { rankSkills, toSkillRankingMarkdown } from "./skill-ranking.js";
import { assertFixturesExist, loadTasks, type TaskDef } from "./tasks.js";
import { runTask, type TaskResult } from "./task-runner.js";
import { getVariant, listVariants } from "./variants.js";

type CliArgs = {
  taskId?: string;
  baseline?: string;
  keep: boolean;
  variants: string[];
  ab?: [string, string];
  skillRanking: boolean;
  listVariants: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { keep: false, variants: [], skillRanking: false, listVariants: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--task":
        args.taskId = argv[++i];
        break;
      case "--baseline":
        args.baseline = argv[++i];
        break;
      case "--keep":
        args.keep = true;
        break;
      case "--variant":
        args.variants.push(argv[++i] ?? "");
        break;
      case "--ab": {
        const pair = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (pair.length !== 2) throw new Error("--ab expects exactly two comma-separated variant names");
        args.ab = [pair[0]!, pair[1]!];
        break;
      }
      case "--skill-ranking":
        args.skillRanking = true;
        break;
      case "--list-variants":
        args.listVariants = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

/** Runs every task under one named variant, printing per-task progress. */
async function runVariant(
  variantName: string,
  tasks: TaskDef[],
  config: ReturnType<typeof loadEvalConfig>,
  keepDir: boolean,
): Promise<TaskResult[]> {
  const variant = getVariant(variantName);
  const options = variant.apply({});
  const createAgent = createDefaultAgentFactory(config, options);
  const results: TaskResult[] = [];
  for (const task of tasks) {
    console.log(`▶ [${variantName}] ${task.id}: ${task.title}`);
    const result = await runTask(task, { createAgent, keepDir, taskSuffix: options.taskSuffix });
    const passed = result.checks.filter((c) => c.passed).length;
    console.log(`  ${result.success ? "✓ pass" : "✗ fail"} (${passed}/${result.checks.length} checks)`);
    for (const check of result.checks) {
      if (!check.passed) console.log(`    ✗ ${check.check.type}: ${check.detail ?? "failed"}`);
    }
    if (result.error) console.log(`    session error: ${result.error}`);
    if (result.workspaceDir) console.log(`    workspace kept: ${result.workspaceDir}`);
    results.push(result);
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
  if (args.taskId !== undefined) {
    tasks = tasks.filter((t) => t.id === args.taskId);
    if (tasks.length === 0) {
      console.error(`error: no task with id "${args.taskId}"`);
      process.exitCode = 1;
      return;
    }
  }

  const config = loadEvalConfig();
  if (!config.apiKey) {
    console.log(
      "No DeepSeek API key found (env DEEPSEEK_API_KEY or .seekforge/config.json); skipping evals.",
    );
    return; // exit 0: skipping is not a failure
  }

  // --ab: run the full set under two variants and compare.
  if (args.ab) {
    const [nameA, nameB] = args.ab;
    const resultsA = await runVariant(nameA, tasks, config, args.keep);
    const resultsB = await runVariant(nameB, tasks, config, args.keep);
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
  const results = await runVariant(variantName, tasks, config, args.keep);

  console.log(`\n${toMarkdown(results)}`);
  if (args.baseline !== undefined) {
    console.log(`\nComparison vs baseline:\n${compare(results, readFileSync(args.baseline, "utf8"))}`);
  }
  if (args.skillRanking) {
    console.log(`\n${toSkillRankingMarkdown(rankSkills(results))}`);
  }

  const { markdownPath, jsonPath } = writeReport(results);
  console.log(`\nReport written:\n  ${markdownPath}\n  ${jsonPath}`);

  if (results.some((r) => !r.success)) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
