import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { aggregateResults } from "./aggregate.js";
import { parseBaseline } from "./baseline.js";
import { costDistribution, proportionCi95, type ConfidenceInterval, type CostDistribution } from "./statistics.js";
import type { TaskResult } from "./task-runner.js";

export type TrendEntry = {
  generatedAt: string;
  report: string;
  kind: "eval" | "ab";
  label: string;
  samples: number;
  successes: number;
  successRate: number;
  successRateCi95: ConfidenceInterval;
  totalCostUsd: number;
  costs: CostDistribution;
};

export type TrendReport = { generatedAt: string; entries: TrendEntry[] };
export type WrittenTrendReport = { markdownPath: string; jsonPath: string; report: TrendReport };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validGeneratedAt(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function parseConfidence(value: unknown): ConfidenceInterval | undefined {
  if (
    !isRecord(value) ||
    value.confidence !== 0.95 ||
    typeof value.lower !== "number" ||
    !Number.isFinite(value.lower) ||
    typeof value.upper !== "number" ||
    !Number.isFinite(value.upper) ||
    value.lower < 0 ||
    value.upper < value.lower
  )
    return undefined;
  return value as ConfidenceInterval;
}

function parseCosts(value: unknown): CostDistribution | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.count) || (value.count as number) < 0) return undefined;
  for (const key of ["min", "p25", "median", "p75", "p95", "max", "mean"] as const) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || (value[key] as number) < 0) return undefined;
  }
  const meanCi95 = parseConfidence(value.meanCi95);
  if (!meanCi95) return undefined;
  return { ...value, meanCi95 } as CostDistribution;
}

function parseTrendEntry(value: unknown): TrendEntry | undefined {
  if (
    !isRecord(value) ||
    !validGeneratedAt(value.generatedAt) ||
    typeof value.report !== "string" ||
    (value.kind !== "eval" && value.kind !== "ab") ||
    typeof value.label !== "string" ||
    !Number.isSafeInteger(value.samples) ||
    (value.samples as number) < 0 ||
    !Number.isSafeInteger(value.successes) ||
    (value.successes as number) < 0 ||
    (value.successes as number) > (value.samples as number) ||
    typeof value.successRate !== "number" ||
    !Number.isFinite(value.successRate) ||
    value.successRate < 0 ||
    value.successRate > 1 ||
    typeof value.totalCostUsd !== "number" ||
    !Number.isFinite(value.totalCostUsd) ||
    value.totalCostUsd < 0
  ) {
    return undefined;
  }
  const successRateCi95 = parseConfidence(value.successRateCi95);
  const costs = parseCosts(value.costs);
  if (!successRateCi95 || !costs) return undefined;
  return { ...value, successRateCi95, costs } as TrendEntry;
}

function entry(
  generatedAt: string,
  report: string,
  kind: TrendEntry["kind"],
  label: string,
  results: TaskResult[],
): TrendEntry {
  const aggregate = aggregateResults(results);
  return {
    generatedAt,
    report,
    kind,
    label,
    samples: aggregate.samples,
    successes: aggregate.successes,
    successRate: aggregate.successRate,
    successRateCi95: proportionCi95(aggregate.successes, aggregate.samples),
    totalCostUsd: aggregate.costUsd,
    costs: costDistribution(results.map((result) => result.metrics.costUsd)),
  };
}

function parseResults(value: unknown): TaskResult[] | undefined {
  try {
    return parseBaseline(JSON.stringify({ results: value }));
  } catch {
    return undefined;
  }
}

function entriesFromFile(path: string): TrendEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !validGeneratedAt(parsed.generatedAt)) return [];
  if (Array.isArray(parsed.entries)) {
    return parsed.entries.map(parseTrendEntry).filter((item): item is TrendEntry => item !== undefined);
  }
  const report = basename(path);
  const standard = parseResults(parsed.results);
  if (standard) {
    const metadata = isRecord(parsed.metadata) ? parsed.metadata : undefined;
    const label = typeof metadata?.variant === "string" ? metadata.variant : "control";
    return [entry(parsed.generatedAt, report, "eval", label, standard)];
  }
  if (!Array.isArray(parsed.variants)) return [];
  const entries: TrendEntry[] = [];
  for (const variant of parsed.variants) {
    if (!isRecord(variant) || typeof variant.variant !== "string") continue;
    const results = parseResults(variant.results);
    if (results) entries.push(entry(parsed.generatedAt, report, "ab", variant.variant, results));
  }
  return entries;
}

export function collectTrends(dir: string): TrendEntry[] {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((file) => file.endsWith(".json") && file !== "trends.json" && file !== "junit.json")
      .map((file) => join(dir, file));
  } catch {
    return [];
  }
  const unique = new Map<string, TrendEntry>();
  for (const item of files.flatMap(entriesFromFile)) {
    unique.set(`${item.generatedAt}\0${item.kind}\0${item.label}\0${item.report}`, item);
  }
  return [...unique.values()].sort(
    (a, b) => Date.parse(a.generatedAt) - Date.parse(b.generatedAt) || a.label.localeCompare(b.label),
  );
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function toTrendMarkdown(entries: TrendEntry[], limit = 40): string {
  const visible = entries.slice(-limit);
  const lines = [
    "# Eval history trends",
    "",
    "| Generated | Kind | Variant | Success (95% CI) | Samples | Mean cost (95% CI) | Median | P95 |",
    "| --- | --- | --- | --- | ---: | --- | ---: | ---: |",
  ];
  for (const item of visible) {
    lines.push(
      `| ${item.generatedAt} | ${item.kind} | ${item.label} | ${percent(item.successRate)} ` +
        `[${percent(item.successRateCi95.lower)}-${percent(item.successRateCi95.upper)}] | ${item.samples} | ` +
        `${item.costs.mean.toFixed(4)} [${item.costs.meanCi95.lower.toFixed(4)}-${item.costs.meanCi95.upper.toFixed(4)}] | ` +
        `${item.costs.median.toFixed(4)} | ${item.costs.p95.toFixed(4)} |`,
    );
  }
  if (entries.length === 0) lines.push("| - | - | - | - | 0 | - | - | - |");
  return lines.join("\n");
}

/** Rebuilds durable trend artifacts from all valid timestamped JSON reports. */
export function writeTrendReport(dir: string): WrittenTrendReport {
  mkdirSync(dir, { recursive: true });
  const report: TrendReport = { generatedAt: new Date().toISOString(), entries: collectTrends(dir) };
  const jsonPath = join(dir, "trends.json");
  const markdownPath = join(dir, "trends.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, `${toTrendMarkdown(report.entries)}\n`);
  return { markdownPath, jsonPath, report };
}
