export type ConfidenceInterval = { lower: number; upper: number; confidence: 0.95 };

export type CostDistribution = {
  count: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
  max: number;
  mean: number;
  meanCi95: ConfidenceInterval;
};

const Z_95 = 1.959963984540054;

function finite(values: number[]): number[] {
  return values.filter((value) => Number.isFinite(value) && value >= 0);
}

/** Wilson score interval for a binomial proportion. */
export function proportionCi95(successes: number, samples: number): ConfidenceInterval {
  if (
    !Number.isSafeInteger(successes) ||
    !Number.isSafeInteger(samples) ||
    samples < 0 ||
    successes < 0 ||
    successes > samples
  ) {
    throw new Error("successes and samples must be safe integers with 0 <= successes <= samples");
  }
  if (samples === 0) return { lower: 0, upper: 1, confidence: 0.95 };
  const rate = successes / samples;
  const z2 = Z_95 * Z_95;
  const denominator = 1 + z2 / samples;
  const center = (rate + z2 / (2 * samples)) / denominator;
  const margin = (Z_95 * Math.sqrt((rate * (1 - rate) + z2 / (4 * samples)) / samples)) / denominator;
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    confidence: 0.95,
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

/** Distribution plus a normal 95% confidence interval for the sample mean. */
export function costDistribution(values: number[]): CostDistribution {
  const sorted = finite(values).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return {
      count: 0,
      min: 0,
      p25: 0,
      median: 0,
      p75: 0,
      p95: 0,
      max: 0,
      mean: 0,
      meanCi95: { lower: 0, upper: 0, confidence: 0.95 },
    };
  }
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  let margin = 0;
  if (sorted.length > 1) {
    const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (sorted.length - 1);
    margin = Z_95 * Math.sqrt(variance / sorted.length);
  }
  return {
    count: sorted.length,
    min: sorted[0]!,
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p95: quantile(sorted, 0.95),
    max: sorted.at(-1)!,
    mean,
    meanCi95: { lower: Math.max(0, mean - margin), upper: mean + margin, confidence: 0.95 },
  };
}
