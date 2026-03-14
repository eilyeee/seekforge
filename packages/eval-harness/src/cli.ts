/**
 * Eval CLI:
 *   pnpm --filter @seekforge/eval-harness eval [-- --task <id>] [--baseline <report.json>] [--keep]
 *
 * Exits 0 with a skip message when no API key is configured; exits 1 when
 * any task failed.
 */

import { readFileSync } from "node:fs";
import { createDefaultAgentFactory } from "./agent-factory.js";
import { loadEvalConfig } from "./config.js";
import { fixturesDir, tasksDir } from "./paths.js";
import { compare, toMarkdown, writeReport } from "./report.js";
import { assertFixturesExist, loadTasks } from "./tasks.js";
import { runTask, type TaskResult } from "./task-runner.js";

type CliArgs = { taskId?: string; baseline?: string; keep: boolean };

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { keep: false };
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
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

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

  const createAgent = createDefaultAgentFactory(config);
  const results: TaskResult[] = [];
  for (const task of tasks) {
    console.log(`▶ ${task.id}: ${task.title}`);
    const result = await runTask(task, { createAgent, keepDir: args.keep });
    const passed = result.checks.filter((c) => c.passed).length;
    console.log(`  ${result.success ? "✓ pass" : "✗ fail"} (${passed}/${result.checks.length} checks)`);
    for (const check of result.checks) {
      if (!check.passed) console.log(`    ✗ ${check.check.type}: ${check.detail ?? "failed"}`);
    }
    if (result.error) console.log(`    session error: ${result.error}`);
    if (result.workspaceDir) console.log(`    workspace kept: ${result.workspaceDir}`);
    results.push(result);
  }

  console.log(`\n${toMarkdown(results)}`);
  if (args.baseline !== undefined) {
    console.log(`\nComparison vs baseline:\n${compare(results, readFileSync(args.baseline, "utf8"))}`);
  }

  const { markdownPath, jsonPath } = writeReport(results);
  console.log(`\nReport written:\n  ${markdownPath}\n  ${jsonPath}`);

  if (results.some((r) => !r.success)) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
