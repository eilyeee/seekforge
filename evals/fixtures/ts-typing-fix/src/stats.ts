/** Arithmetic mean of the values; 0 for an empty list. */
export function average(values: number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
}

/** Human-readable summary, e.g. "avg=2.50". */
export function describeAverage(values: number[]): string {
  const avg: string = average(values);
  return `avg=${avg.toFixed(2)}`;
}
