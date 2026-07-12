import { createHash } from "node:crypto";
import { MAX_VERIFY_DIAGNOSTIC_INPUT } from "./loop-constants.js";

export type VerifyFramework = "vitest" | "jest" | "pytest" | "cargo" | "unknown";

export type VerifyDiagnostic = {
  file?: string;
  line?: number;
  message: string;
};

export type VerifyDiagnostics = {
  framework: VerifyFramework;
  failedTests: string[];
  diagnostics: VerifyDiagnostic[];
  summary: string;
  fingerprint: string;
};

export type VerifyDiagnosticsOptions = {
  maxFailedTests?: number;
  maxDiagnostics?: number;
  maxTextLength?: number;
};

const DEFAULT_MAX_FAILED_TESTS = 20;
const DEFAULT_MAX_DIAGNOSTICS = 20;
const DEFAULT_MAX_TEXT_LENGTH = 500;
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function limit(value: number | undefined, fallback: number, max: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.min(Math.floor(value!), max) : fallback;
}

function clean(value: string, maxLength: number): string {
  const normalized = value
    .replace(ANSI_PATTERN, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function detectFramework(output: string): VerifyFramework {
  if (/\b(?:vitest|vite-node)\b/i.test(output) || /\bTest Files\s+\d+ failed/i.test(output)) return "vitest";
  if (/\bjest\b/i.test(output) || /\bTest Suites:\s+\d+ failed/i.test(output)) return "jest";
  if (/\bpytest\b/i.test(output) || /={2,}\s+(?:FAILURES|short test summary info)\s+={2,}/i.test(output)) return "pytest";
  if (/\b(?:cargo test|running \d+ tests?)\b/i.test(output) && /\btest result:/i.test(output)) return "cargo";
  return "unknown";
}

function uniqueBounded(values: string[], max: number, textMax: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const item = clean(value, textMax).replace(/\s+\d+(?:\.\d+)?\s*(?:ms|s)\s*$/i, "");
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length === max) break;
  }
  return result;
}

function extractFailedTests(output: string, framework: VerifyFramework): string[] {
  const found: string[] = [];
  const patterns: RegExp[] = framework === "pytest"
    ? [/^FAILED\s+(.+?)(?:\s+-\s+.*)?$/gm, /^_{2,}\s+(.+?)\s+_{2,}$/gm]
    : framework === "cargo"
      ? [/^test\s+(.+?)\s+\.\.\.\s+FAILED\s*$/gm, /^\s*(.+?)\s+--- FAILED\s*$/gm]
      : [/^\s*[×✕]\s+(.+?)(?:\s+\d+ms)?\s*$/gm, /^\s*FAIL\s+(.+?)\s*$/gm, /^\s*●\s+(.+?)\s*$/gm];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) found.push(match[1] ?? "");
  }
  return found;
}

function extractDiagnostics(output: string, framework: VerifyFramework): VerifyDiagnostic[] {
  const result: VerifyDiagnostic[] = [];
  const lines = output.split("\n");
  const locationPatterns = framework === "pytest"
    ? [/^(.+?\.py):(\d+):\s*(?:AssertionError:\s*)?(.+)$/, /^E\s+(.+)$/]
    : framework === "cargo"
      ? [/^\s*-->\s+(.+?\.rs):(\d+)(?::\d+)?\s*$/, /^(?:thread .+?\s+)?panicked at\s+['\"]?(.+?)['\"]?,\s+(.+?\.rs):(\d+)(?::\d+)?\s*$/]
      : [/^at\s+(?:.*?\s+\()?((?:[A-Za-z]:)?[^():]+\.[cm]?[jt]sx?):(\d+):\d+\)?\s*$/, /^([^:]+\.[cm]?[jt]sx?):(\d+)(?::\d+)?\s*(?:[-:]\s*)?(.+)$/];

  let pendingMessage = "";
  for (const rawLine of lines) {
    const line = clean(rawLine, 1_000);
    if (!line) continue;
    if (/^(?:AssertionError|Error|TypeError|ReferenceError|E\s+|thread .* panicked)/.test(line)) pendingMessage = line.replace(/^E\s+/, "");
    for (const pattern of locationPatterns) {
      const match = line.match(pattern);
      if (!match) continue;
      if (framework === "pytest" && pattern === locationPatterns[1]) {
        pendingMessage = match[1] ?? pendingMessage;
        break;
      }
      if (framework === "cargo" && pattern === locationPatterns[1]) {
        result.push({ file: match[2], line: Number(match[3]), message: match[1] ?? "test panicked" });
      } else {
        result.push({
          file: match[1],
          line: Number(match[2]),
          message: match[3] ?? (pendingMessage || "test failed"),
        });
      }
      break;
    }
  }
  return result;
}

function normalizeForFingerprint(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/gi, "<duration>")
    .replace(/\b0x[\da-f]+\b/gi, "<address>")
    .replace(/\/[^\s:]+\/node_modules\//g, "node_modules/")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function parseVerifyDiagnostics(output: string, options: VerifyDiagnosticsOptions = {}): VerifyDiagnostics {
  const maxText = limit(options.maxTextLength, DEFAULT_MAX_TEXT_LENGTH, 4_000);
  const maxTests = limit(options.maxFailedTests, DEFAULT_MAX_FAILED_TESTS, 100);
  const maxDiagnostics = limit(options.maxDiagnostics, DEFAULT_MAX_DIAGNOSTICS, 100);
  const boundedInput = output.length <= MAX_VERIFY_DIAGNOSTIC_INPUT
    ? output
    : `${output.slice(0, MAX_VERIFY_DIAGNOSTIC_INPUT / 2)}\n... output omitted ...\n${output.slice(-MAX_VERIFY_DIAGNOSTIC_INPUT / 2)}`;
  const boundedOutput = boundedInput.replace(ANSI_PATTERN, "");
  const framework = detectFramework(boundedOutput);
  const allFailedTests = framework === "unknown"
    ? []
    : uniqueBounded(extractFailedTests(boundedOutput, framework), 10_000, maxText);
  const allDiagnostics = (framework === "unknown" ? [] : extractDiagnostics(boundedOutput, framework))
    .map((item) => ({ ...item, file: item.file ? clean(item.file, maxText) : undefined, message: clean(item.message, maxText) }))
    .filter((item) => item.message)
    .filter((item, index, all) => all.findIndex((other) => other.file === item.file && other.line === item.line && other.message === item.message) === index);
  const failedTests = allFailedTests.slice(0, maxTests);
  const diagnostics = allDiagnostics.slice(0, maxDiagnostics);
  const summary = framework === "unknown"
    ? clean(boundedOutput.split("\n").filter(Boolean).slice(-8).join("\n"), maxText)
    : clean(`${failedTests.length} failed test(s), ${diagnostics.length} location(s)`, maxText);
  const fingerprintInput = JSON.stringify({
    framework,
    failedTests: [...allFailedTests].map(normalizeForFingerprint).sort(),
    diagnostics: allDiagnostics.map((item) => ({
      file: normalizeForFingerprint(item.file ?? ""),
      line: item.line ?? 0,
      message: normalizeForFingerprint(item.message),
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    fallback: framework === "unknown" ? normalizeForFingerprint(summary) : "",
  });
  return { framework, failedTests, diagnostics, summary, fingerprint: createHash("sha256").update(fingerprintInput).digest("hex") };
}
