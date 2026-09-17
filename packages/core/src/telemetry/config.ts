/**
 * OpenTelemetry export settings, read from the environment only.
 *
 * Opt-in: nothing is exported unless SEEKFORGE_ENABLE_TELEMETRY is set. The
 * `OTEL_*` variables are the standard exporter ones, with one restriction —
 * only OTLP over HTTP with JSON bodies is implemented, so any other
 * `OTEL_EXPORTER_OTLP_PROTOCOL` turns export off with a warning rather than
 * sending a format the collector did not ask for.
 *
 * Environment only, never config files: a repository must not be able to
 * choose where a user's usage data goes.
 */

const DEFAULT_ENDPOINT = "http://localhost:4318";
const DEFAULT_METRIC_INTERVAL_MS = 60_000;
/** Longer than the spec's 1s batch delay: one request per few seconds is plenty for a CLI. */
const DEFAULT_LOG_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 24 * 60 * 60_000;
const MAX_TIMEOUT_MS = 60_000;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export type TelemetrySettings = {
  /** Where metrics are POSTed; undefined when the metrics exporter is off. */
  metricsUrl?: string;
  /** Where log records are POSTed; undefined when the logs exporter is off. */
  logsUrl?: string;
  headers: Record<string, string>;
  timeoutMs: number;
  metricIntervalMs: number;
  logIntervalMs: number;
  /** From OTEL_RESOURCE_ATTRIBUTES / OTEL_SERVICE_NAME, before SeekForge's defaults are added. */
  resource: Record<string, string>;
  logUserPrompts: boolean;
};

export type TelemetryResolution =
  | { enabled: false; warnings: string[] }
  | { enabled: true; settings: TelemetrySettings; warnings: string[] };

function truthy(value: string | undefined): boolean {
  return value !== undefined && /^(?:1|true)$/i.test(value.trim());
}

function interval(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || !/^\s*\d+\s*$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? Math.min(Math.max(value, min), max) : fallback;
}

/** `key=value,key2=value2`, percent-decoded (the W3C baggage form the OTel spec uses). */
function parseKeyValueList(raw: string | undefined, what: string, warnings: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined) return out;
  for (const part of raw.split(",")) {
    if (part.trim() === "") continue;
    const eq = part.indexOf("=");
    try {
      if (eq <= 0) throw new Error("no key");
      const key = decodeURIComponent(part.slice(0, eq).trim());
      const value = decodeURIComponent(part.slice(eq + 1).trim());
      if (key === "") throw new Error("empty key");
      out[key] = value;
    } catch {
      // The entry may be a secret header; say where it was, never what it was.
      warnings.push(`${what}: ignored a malformed entry`);
    }
  }
  return out;
}

function signalUrl(env: NodeJS.ProcessEnv, signal: "metrics" | "logs", warnings: string[]): string | undefined {
  const exporterVar = signal === "metrics" ? "OTEL_METRICS_EXPORTER" : "OTEL_LOGS_EXPORTER";
  const exporter = (env[exporterVar] ?? "otlp").trim().toLowerCase();
  if (exporter === "none") return undefined;
  if (exporter !== "otlp") {
    warnings.push(`${exporterVar}=${exporter} is not supported (only otlp); ${signal} export is off`);
    return undefined;
  }
  const specific =
    env[signal === "metrics" ? "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT" : "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"];
  const useSpecific = specific !== undefined && specific.trim() !== "";
  let url: URL;
  try {
    // A signal-specific endpoint is used as given; the base one gets the
    // signal's path appended to its path (not to the end of the string, which
    // would land inside a query).
    url = new URL(useSpecific ? specific.trim() : env["OTEL_EXPORTER_OTLP_ENDPOINT"]?.trim() || DEFAULT_ENDPOINT);
    if (!useSpecific) url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/${signal}`;
  } catch {
    warnings.push(`the OTLP ${signal} endpoint is not a valid URL; ${signal} export is off`);
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    warnings.push(`the OTLP ${signal} endpoint must be http(s); ${signal} export is off`);
    return undefined;
  }
  return url.toString();
}

export function resolveTelemetrySettings(env: NodeJS.ProcessEnv = process.env): TelemetryResolution {
  const warnings: string[] = [];
  if (!truthy(env["SEEKFORGE_ENABLE_TELEMETRY"])) return { enabled: false, warnings };

  const protocol = env["OTEL_EXPORTER_OTLP_PROTOCOL"]?.trim().toLowerCase();
  if (protocol !== undefined && protocol !== "" && protocol !== "http/json") {
    warnings.push(
      `OTEL_EXPORTER_OTLP_PROTOCOL=${protocol} is not supported; SeekForge exports OTLP http/json only, so telemetry is off`,
    );
    return { enabled: false, warnings };
  }

  const metricsUrl = signalUrl(env, "metrics", warnings);
  const logsUrl = signalUrl(env, "logs", warnings);
  if (metricsUrl === undefined && logsUrl === undefined) return { enabled: false, warnings };

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(
    parseKeyValueList(env["OTEL_EXPORTER_OTLP_HEADERS"], "OTEL_EXPORTER_OTLP_HEADERS", warnings),
  )) {
    if (HEADER_NAME.test(name) && !/[\r\n\0]/.test(value)) headers[name.toLowerCase()] = value;
    else warnings.push("OTEL_EXPORTER_OTLP_HEADERS: ignored an entry that is not a valid HTTP header");
  }
  // The body is always JSON; a header claiming otherwise would only confuse the collector.
  delete headers["content-type"];
  delete headers["content-length"];

  const resource = parseKeyValueList(env["OTEL_RESOURCE_ATTRIBUTES"], "OTEL_RESOURCE_ATTRIBUTES", warnings);
  const serviceName = env["OTEL_SERVICE_NAME"]?.trim();
  if (serviceName) resource["service.name"] = serviceName;

  return {
    enabled: true,
    warnings,
    settings: {
      ...(metricsUrl !== undefined ? { metricsUrl } : {}),
      ...(logsUrl !== undefined ? { logsUrl } : {}),
      headers,
      timeoutMs: interval(env["OTEL_EXPORTER_OTLP_TIMEOUT"], DEFAULT_TIMEOUT_MS, 100, MAX_TIMEOUT_MS),
      metricIntervalMs: interval(
        env["OTEL_METRIC_EXPORT_INTERVAL"],
        DEFAULT_METRIC_INTERVAL_MS,
        MIN_INTERVAL_MS,
        MAX_INTERVAL_MS,
      ),
      logIntervalMs: interval(
        env["OTEL_BLRP_SCHEDULE_DELAY"],
        DEFAULT_LOG_INTERVAL_MS,
        MIN_INTERVAL_MS,
        MAX_INTERVAL_MS,
      ),
      resource,
      logUserPrompts: truthy(env["OTEL_LOG_USER_PROMPTS"]),
    },
  };
}

/** An endpoint as a doctor line may print it: no credentials, no query. */
export function redactEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "(invalid URL)";
  }
}
