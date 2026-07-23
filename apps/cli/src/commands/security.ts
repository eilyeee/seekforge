import {
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  buildFindingFixPrompt,
  buildSecurityState,
  changeFindingStatus,
  changeFindingVerification,
  completeFixAttempt,
  createAgentCore,
  generateThreatModel,
  getFinding,
  isSameFindingFamily,
  listFindings,
  renderSecurityExport,
  runProjectSecurityChecks,
  sanitizeSecurityText,
  scanRepository,
  startFixAttempt,
  writeSecurityExport,
  type Finding,
  type FindingSeverity,
  type FindingStatus,
  type RepositoryScanResult,
  type SecurityExportFormat,
} from "@seekforge/core";
import { createCliAgentDeps } from "../agent-factory.js";
import { fail } from "../colors.js";
import { loadConfig } from "../config.js";
import { runTaskCommand } from "./run.js";

export type SecurityScanOptions = { model?: string; maxFindings?: number; json?: boolean };
export type SecurityListOptions = { status?: string; severity?: string; json?: boolean };
export type SecurityFixOptions = { model?: string; maxCost: number; yes?: boolean };

function asError(error: unknown): string {
  return sanitizeSecurityText(error instanceof Error ? error.message : String(error), 2_000);
}

async function withSecurityAgent<T>(
  model: string | undefined,
  operation: (agent: ReturnType<typeof createAgentCore>) => Promise<T>,
): Promise<T> {
  const config = loadConfig(process.cwd());
  if (!config.apiKey) throw new Error("no provider API key configured; run `seekforge doctor` for setup help");
  const { deps, dispose } = createCliAgentDeps({
    config,
    workspace: process.cwd(),
    ...(model ? { model } : {}),
    confirm: async () => false,
    extractMemory: false,
  });
  try {
    return await operation(createAgentCore(deps));
  } finally {
    dispose();
  }
}

async function runScan(options: SecurityScanOptions): Promise<RepositoryScanResult> {
  const workspace = process.cwd();
  return await withSecurityAgent(
    options.model,
    async (agent) =>
      await scanRepository({
        workspace,
        agent,
        ...(options.maxFindings !== undefined ? { maxFindings: options.maxFindings } : {}),
      }),
  );
}

function printFinding(finding: Finding): void {
  const location = finding.evidence[0];
  console.log(
    `${finding.id}  ${finding.severity.padEnd(8)} ${finding.status.padEnd(13)} ${finding.verificationStatus.padEnd(10)} ${finding.title}`,
  );
  if (location) console.log(`  ${location.path}:${location.lineStart}-${location.lineEnd}`);
}

export async function securityScanCommand(options: SecurityScanOptions = {}): Promise<void> {
  try {
    const result = await runScan(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`scan ${result.scan.id} completed: ${result.findings.length} finding(s)`);
    for (const finding of result.findings) printFinding(finding);
  } catch (error) {
    fail(`security scan failed: ${asError(error)}`);
  }
}

function parseStatus(value: string | undefined): FindingStatus | undefined {
  if (value === undefined) return undefined;
  if (!FINDING_STATUSES.includes(value as FindingStatus)) throw new Error(`unknown finding status: ${value}`);
  return value as FindingStatus;
}

function parseSeverity(value: string | undefined): FindingSeverity | undefined {
  if (value === undefined) return undefined;
  if (!FINDING_SEVERITIES.includes(value as FindingSeverity)) throw new Error(`unknown finding severity: ${value}`);
  return value as FindingSeverity;
}

export function securityListCommand(options: SecurityListOptions = {}): void {
  try {
    const findings = listFindings(process.cwd(), {
      ...(parseStatus(options.status) ? { status: parseStatus(options.status)! } : {}),
      ...(parseSeverity(options.severity) ? { severity: parseSeverity(options.severity)! } : {}),
    });
    if (options.json) {
      console.log(JSON.stringify(findings, null, 2));
      return;
    }
    if (findings.length === 0) {
      console.log("no security findings");
      return;
    }
    for (const finding of findings) printFinding(finding);
  } catch (error) {
    fail(asError(error));
  }
}

export function securityShowCommand(findingId: string, options: { json?: boolean } = {}): void {
  try {
    const finding = getFinding(process.cwd(), findingId);
    if (!finding) throw new Error(`finding not found: ${findingId}`);
    if (options.json) {
      console.log(JSON.stringify(finding, null, 2));
      return;
    }
    printFinding(finding);
    console.log(`\n${finding.description}\n\nRecommendation: ${finding.recommendation}`);
    for (const evidence of finding.evidence) {
      console.log(`\n${evidence.path}:${evidence.lineStart}-${evidence.lineEnd}\n${evidence.excerpt}`);
    }
  } catch (error) {
    fail(asError(error));
  }
}

export function securityStatusCommand(findingId: string, status: string, options: { reason?: string } = {}): void {
  try {
    const parsed = parseStatus(status);
    if (!parsed) throw new Error("finding status is required");
    const finding = changeFindingStatus(process.cwd(), findingId, parsed, options.reason ?? "changed by user");
    console.log(`${finding.id}: ${finding.status}`);
  } catch (error) {
    fail(asError(error));
  }
}

export async function securityThreatModelCommand(options: { model?: string; json?: boolean } = {}): Promise<void> {
  try {
    const model = await withSecurityAgent(
      options.model,
      async (agent) => await generateThreatModel({ workspace: process.cwd(), agent }),
    );
    if (options.json) console.log(JSON.stringify(model, null, 2));
    else console.log(`threat model ${model.id}: ${model.threats.length} threat(s), ${model.assets.length} asset(s)`);
  } catch (error) {
    fail(`threat model failed: ${asError(error)}`);
  }
}

const severityRank: Record<FindingSeverity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

function introducedBlockingFindings(beforeIds: Set<string>, target: Finding, result: RepositoryScanResult): string[] {
  return result.findings
    .filter((finding) => !beforeIds.has(finding.id))
    .filter((finding) => severityRank[finding.severity] >= severityRank[target.severity])
    .map((finding) => finding.id);
}

function findingStillPresent(target: Finding, findings: Finding[]): boolean {
  return findings.some((candidate) => isSameFindingFamily(target, candidate));
}

export async function securityFixCommand(findingId: string, options: SecurityFixOptions): Promise<void> {
  const workspace = process.cwd();
  if (!Number.isFinite(options.maxCost) || options.maxCost <= 0) {
    fail("--max-cost <usd> must be a positive number");
    return;
  }
  let finding = getFinding(workspace, findingId);
  if (!finding) {
    fail(`finding not found: ${findingId}`);
    return;
  }
  const beforeIds = new Set(buildSecurityState(workspace).findings.keys());
  let fix: ReturnType<typeof startFixAttempt>;
  try {
    fix = startFixAttempt(workspace, findingId);
  } catch (error) {
    fail(asError(error));
    return;
  }

  let agentCompleted = false;
  let commands: Awaited<ReturnType<typeof runProjectSecurityChecks>> = [];
  let rescan: RepositoryScanResult | undefined;
  try {
    agentCompleted = await runTaskCommand(buildFindingFixPrompt(finding), {
      mode: "edit",
      permissionMode: options.yes ? "auto" : "acceptEdits",
      maxCostUsd: options.maxCost,
      ...(options.model ? { model: options.model } : {}),
    });
    if (agentCompleted) {
      const config = loadConfig(workspace);
      commands = await runProjectSecurityChecks({
        workspace,
        ...(config.sandbox ? { sandbox: config.sandbox } : {}),
        ...(config.verifyCommand ? { verifyCommand: config.verifyCommand } : {}),
        ...(config.lintCommand ? { lintCommand: config.lintCommand } : {}),
      });
    }
    if (
      agentCompleted &&
      commands.length > 0 &&
      commands.every((command) => command.exitCode === 0 && !command.timedOut)
    ) {
      rescan = await runScan({ ...(options.model ? { model: options.model } : {}) });
    }
  } catch (error) {
    console.error(`security fix or verification failed: ${asError(error)}`);
  }
  finding = getFinding(workspace, findingId) ?? finding;
  const completed = completeFixAttempt({
    workspace,
    fix,
    agentCompleted,
    commands,
    ...(rescan ? { verificationScan: rescan.scan } : {}),
    ...(rescan ? { findingStillPresent: findingStillPresent(finding, rescan.findings) } : {}),
    ...(rescan ? { introducedBlockingFindings: introducedBlockingFindings(beforeIds, finding, rescan) } : {}),
  });
  console.log(`${findingId}: fix ${completed.status}`);
  if (completed.notes) console.log(completed.notes);
  if (completed.status !== "verified") process.exitCode = 1;
}

export async function securityVerifyCommand(findingId: string, options: { model?: string } = {}): Promise<void> {
  const workspace = process.cwd();
  const finding = getFinding(workspace, findingId);
  if (!finding) {
    fail(`finding not found: ${findingId}`);
    return;
  }
  try {
    const config = loadConfig(workspace);
    const commands = await runProjectSecurityChecks({
      workspace,
      ...(config.sandbox ? { sandbox: config.sandbox } : {}),
      ...(config.verifyCommand ? { verifyCommand: config.verifyCommand } : {}),
      ...(config.lintCommand ? { lintCommand: config.lintCommand } : {}),
    });
    const result =
      commands.length > 0 && commands.every((command) => command.exitCode === 0 && !command.timedOut)
        ? await runScan({ ...(options.model ? { model: options.model } : {}) })
        : undefined;
    const present = result ? findingStillPresent(finding, result.findings) : true;
    const passed =
      result !== undefined && !present && commands.every((command) => command.exitCode === 0 && !command.timedOut);
    changeFindingVerification(
      workspace,
      findingId,
      passed ? "verified" : "failed",
      passed ? "finding absent on rescan and configured checks passed" : "finding remains or configured checks failed",
      result?.scan.id,
    );
    if (passed && ["open", "triaged", "fixing", "reopened"].includes(finding.status)) {
      changeFindingStatus(workspace, findingId, "resolved", "manual verification passed");
    }
    console.log(`${findingId}: ${passed ? "verified" : "verification failed"}`);
    if (!passed) process.exitCode = 1;
  } catch (error) {
    fail(`verification failed: ${asError(error)}`);
  }
}

export function securityExportCommand(options: { format: string; output?: string }): void {
  try {
    if (!(["json", "markdown", "sarif"] as string[]).includes(options.format)) {
      throw new Error(`unknown security export format: ${options.format}`);
    }
    const format = options.format as SecurityExportFormat;
    if (options.output) {
      const target = writeSecurityExport(process.cwd(), options.output, format);
      console.log(`wrote ${format} security evidence to ${target}`);
    } else {
      process.stdout.write(renderSecurityExport(process.cwd(), format));
    }
  } catch (error) {
    fail(`security export failed: ${asError(error)}`);
  }
}
