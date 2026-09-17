/**
 * OTLP/JSON request bodies (opentelemetry-proto, JSON mapping).
 *
 * Only what SeekForge sends: cumulative monotonic sums and log records. The
 * JSON mapping has two rules that are easy to get wrong and that collectors
 * enforce: 64-bit integers (timestamps, int values) are decimal strings, and
 * enums (aggregation temporality, severity) are integers.
 */

export type AttributeValue = string | number | boolean;
export type Attributes = Record<string, AttributeValue>;

type AnyValue = { stringValue: string } | { boolValue: boolean } | { intValue: string } | { doubleValue: number };
type KeyValue = { key: string; value: AnyValue };

/** AGGREGATION_TEMPORALITY_CUMULATIVE */
const CUMULATIVE = 2;
/** SEVERITY_NUMBER_INFO / SEVERITY_NUMBER_ERROR */
export const SEVERITY_INFO = 9;
export const SEVERITY_ERROR = 17;

function anyValue(value: AttributeValue): AnyValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}

export function keyValues(attributes: Attributes): KeyValue[] {
  return Object.keys(attributes)
    .sort()
    .map((key) => ({ key, value: anyValue(attributes[key]!) }));
}

/** Epoch milliseconds as the decimal nanosecond string OTLP/JSON expects. */
export function unixNanos(ms: number): string {
  return `${Math.max(0, Math.floor(ms))}000000`;
}

export type SumPoint = {
  name: string;
  description: string;
  unit: string;
  attributes: Attributes;
  value: number;
  /** Counts are sent as ints, money as doubles. */
  integer: boolean;
};

export type LogRecord = {
  timeMs: number;
  severity: number;
  /** `event.name` — also the record body. */
  event: string;
  attributes: Attributes;
};

export type Scope = { name: string; version: string };

export function encodeMetrics(
  resource: Attributes,
  scope: Scope,
  points: readonly SumPoint[],
  startMs: number,
  nowMs: number,
): string {
  const byName = new Map<string, { point: SumPoint; dataPoints: unknown[] }>();
  for (const point of points) {
    const entry = byName.get(point.name) ?? { point, dataPoints: [] };
    entry.dataPoints.push({
      attributes: keyValues(point.attributes),
      startTimeUnixNano: unixNanos(startMs),
      timeUnixNano: unixNanos(nowMs),
      ...(point.integer ? { asInt: String(Math.round(point.value)) } : { asDouble: point.value }),
    });
    byName.set(point.name, entry);
  }
  return JSON.stringify({
    resourceMetrics: [
      {
        resource: { attributes: keyValues(resource) },
        scopeMetrics: [
          {
            scope,
            metrics: [...byName.values()].map(({ point, dataPoints }) => ({
              name: point.name,
              description: point.description,
              unit: point.unit,
              sum: { aggregationTemporality: CUMULATIVE, isMonotonic: true, dataPoints },
            })),
          },
        ],
      },
    ],
  });
}

export function encodeLogs(resource: Attributes, scope: Scope, records: readonly LogRecord[]): string {
  return JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: keyValues(resource) },
        scopeLogs: [
          {
            scope,
            logRecords: records.map((record) => ({
              timeUnixNano: unixNanos(record.timeMs),
              observedTimeUnixNano: unixNanos(record.timeMs),
              severityNumber: record.severity,
              severityText: record.severity >= SEVERITY_ERROR ? "ERROR" : "INFO",
              body: { stringValue: record.event },
              attributes: keyValues({ ...record.attributes, "event.name": record.event }),
            })),
          },
        ],
      },
    ],
  });
}
