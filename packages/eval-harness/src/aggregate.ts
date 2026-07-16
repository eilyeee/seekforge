import type { TaskResult } from "./task-runner.js";

export type AggregateMetrics = {
  samples: number;
  successes: number;
  successRate: number;
  sessionErrors: number;
  sessionErrorRate: number;
  toolCalls: number;
  failedToolCalls: number;
  toolFailureRate: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  totalTokens: number;
  durationMs: number;
  costUsd: number;
  costPerSuccessUsd: number | null;
  tokensPerSuccess: number | null;
};

export type TaskAggregate = AggregateMetrics & { taskId: string };

export type RunAggregate = AggregateMetrics & {
  tasks: number;
  taskResults: TaskAggregate[];
};

function metric(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function summarizeSamples(results: TaskResult[]): AggregateMetrics {
  const samples = results.length;
  const successes = results.filter((result) => result.success).length;
  const sessionErrors = results.filter((result) => result.error !== undefined).length;
  const toolCalls = results.reduce((sum, result) => sum + metric(result.metrics.toolCalls), 0);
  const failedToolCalls = results.reduce((sum, result) => sum + metric(result.metrics.failedToolCalls), 0);
  const promptTokens = results.reduce((sum, result) => sum + metric(result.metrics.promptTokens), 0);
  const completionTokens = results.reduce((sum, result) => sum + metric(result.metrics.completionTokens), 0);
  const cacheHitTokens = results.reduce((sum, result) => sum + metric(result.metrics.cacheHitTokens), 0);
  const totalTokens = results.reduce((sum, result) => {
    const reported = result.metrics.totalTokens;
    return (
      sum +
      (reported === undefined
        ? metric(result.metrics.promptTokens) + metric(result.metrics.completionTokens)
        : metric(reported))
    );
  }, 0);
  const costUsd = results.reduce((sum, result) => sum + metric(result.metrics.costUsd), 0);
  return {
    samples,
    successes,
    successRate: samples === 0 ? 0 : successes / samples,
    sessionErrors,
    sessionErrorRate: samples === 0 ? 0 : sessionErrors / samples,
    toolCalls,
    failedToolCalls,
    toolFailureRate: toolCalls === 0 ? 0 : failedToolCalls / toolCalls,
    promptTokens,
    completionTokens,
    cacheHitTokens,
    totalTokens,
    durationMs: results.reduce((sum, result) => sum + metric(result.metrics.durationMs), 0),
    costUsd,
    costPerSuccessUsd: successes === 0 ? null : costUsd / successes,
    tokensPerSuccess: successes === 0 ? null : totalTokens / successes,
  };
}

export function aggregateResults(results: TaskResult[]): RunAggregate {
  const byTask = new Map<string, TaskResult[]>();
  for (const result of results) {
    const samples = byTask.get(result.taskId) ?? [];
    samples.push(result);
    byTask.set(result.taskId, samples);
  }
  const taskResults = [...byTask.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([taskId, samples]) => ({ taskId, ...summarizeSamples(samples) }));
  return { tasks: taskResults.length, taskResults, ...summarizeSamples(results) };
}
