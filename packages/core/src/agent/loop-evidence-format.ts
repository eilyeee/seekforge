import type { LoopEvidenceFormat, LoopEvidenceReport } from "./loop-evidence.js";

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function exportSarif(report: LoopEvidenceReport): string {
  const results = [
    ...report.criteria
      .filter((item) => item.status !== "met")
      .map((item) => ({
        ruleId: `acceptance/${item.id}`,
        level: item.status === "unmet" ? "error" : "warning",
        message: { text: item.text },
      })),
    ...report.verification
      .filter((item) => item.required && item.code !== 0)
      .map((item) => ({
        ruleId: `verification/${item.id}`,
        level: item.code === undefined ? "warning" : "error",
        message: {
          text: item.code === undefined ? `${item.command} has no result` : `${item.command} exited ${item.code}`,
        },
      })),
  ];
  return `${JSON.stringify(
    {
      version: "2.1.0",
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      runs: [{ tool: { driver: { name: "SeekForge Loop", version: "1" } }, results }],
    },
    null,
    2,
  )}\n`;
}

function exportJunit(report: LoopEvidenceReport): string {
  const cases = [
    ...report.criteria.map(
      (item) =>
        `<testcase classname="acceptance" name="${xml(item.id)}">${item.status === "met" ? "" : `<failure message="${xml(item.status)}">${xml(item.text)}</failure>`}</testcase>`,
    ),
    ...report.verification.map(
      (item) =>
        `<testcase classname="verification" name="${xml(item.id)}">${item.required && item.code !== 0 ? `<failure message="${item.code === undefined ? "missing result" : `exit ${item.code}`}">${xml(item.command)}</failure>` : ""}</testcase>`,
    ),
  ];
  const failures = cases.filter((item) => item.includes("<failure")).length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="SeekForge Loop ${xml(report.loopId)}" tests="${cases.length}" failures="${failures}">${cases.join("")}</testsuite>\n`;
}

export function exportLoopEvidence(report: LoopEvidenceReport, format: LoopEvidenceFormat): string {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
  return format === "sarif" ? exportSarif(report) : exportJunit(report);
}
