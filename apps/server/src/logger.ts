export type LogLevel = "info" | "warn" | "error";

export type StructuredLogger = {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
};

export function createStructuredLogger(
  sink: (line: string) => void = (line) => console.error(line),
): StructuredLogger {
  return {
    log(level, event, fields = {}) {
      sink(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
    },
  };
}
