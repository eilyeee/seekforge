import { InvalidArgumentError, type Command } from "commander";
import {
  securityExportCommand,
  securityFixCommand,
  securityListCommand,
  securityScanCommand,
  securityShowCommand,
  securityStatusCommand,
  securityThreatModelCommand,
  securityVerifyCommand,
} from "./security.js";

function positiveInt(value: string): number {
  if (!/^\d+$/.test(value)) throw new InvalidArgumentError("must be a positive integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new InvalidArgumentError("must be an integer from 1 to 100");
  }
  return parsed;
}

function positiveFloat(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new InvalidArgumentError("must be a positive number");
  return parsed;
}

export function registerSecurityCommands(program: Command): void {
  const security = program
    .command("security")
    .description("scan, triage, fix, verify, and export repository security findings");
  security
    .command("scan")
    .option("-m, --model <model>", "override model")
    .option("--max-findings <n>", "maximum accepted findings (1-100)", positiveInt, 50)
    .option("--json", "emit scan and findings as JSON")
    .description("run a repository-wide read-only Agent security scan")
    .action(async (opts: { model?: string; maxFindings: number; json?: boolean }) => await securityScanCommand(opts));
  security
    .command("list", { isDefault: true })
    .option("--status <status>", "filter by lifecycle status")
    .option("--severity <severity>", "filter by severity")
    .option("--json", "emit JSON")
    .description("list the current Finding queue")
    .action((opts: { status?: string; severity?: string; json?: boolean }) => securityListCommand(opts));
  security
    .command("show")
    .argument("<finding-id>")
    .option("--json", "emit JSON")
    .description("show one Finding and its evidence")
    .action((id: string, opts: { json?: boolean }) => securityShowCommand(id, opts));
  security
    .command("status")
    .argument("<finding-id>")
    .argument("<status>")
    .option("--reason <text>", "record the triage reason")
    .description("change a Finding lifecycle status")
    .action((id: string, status: string, opts: { reason?: string }) => securityStatusCommand(id, status, opts));
  security
    .command("fix")
    .argument("<finding-id>")
    .requiredOption("--max-cost <usd>", "maximum Agent cost in USD", positiveFloat)
    .option("-m, --model <model>", "override model")
    .option("-y, --yes", "auto-approve Agent permissions")
    .description("fix a Finding, run project checks, and rescan")
    .action(
      async (id: string, opts: { maxCost: number; model?: string; yes?: boolean }) =>
        await securityFixCommand(id, opts),
    );
  security
    .command("verify")
    .argument("<finding-id>")
    .option("-m, --model <model>", "override model")
    .description("run project checks and rescan one Finding")
    .action(async (id: string, opts: { model?: string }) => await securityVerifyCommand(id, opts));
  security
    .command("threat-model")
    .option("-m, --model <model>", "override model")
    .option("--json", "emit JSON")
    .description("generate and persist an evidence-backed repository threat model")
    .action(async (opts: { model?: string; json?: boolean }) => await securityThreatModelCommand(opts));
  security
    .command("export")
    .requiredOption("--format <format>", "json | markdown | sarif")
    .option("-o, --output <path>", "write inside the workspace instead of stdout")
    .description("export a redacted compliance evidence package")
    .action((opts: { format: string; output?: string }) => securityExportCommand(opts));
}
