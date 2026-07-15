/** Repository security workflows backed by @seekforge/core's event store. */

import {
  FINDING_STATUSES,
  buildFindingFixPrompt,
  buildSecurityEvidencePackage,
  changeFindingStatus,
  completeFixAttempt,
  generateThreatModel,
  getFinding,
  isSameFindingFamily,
  renderSecurityExport,
  runProjectSecurityChecks,
  scanRepository,
  startFixAttempt,
  type Finding,
  type FindingSeverity,
  type SecurityExportFormat,
} from "@seekforge/core";
import { readJsonBody, sendApiError, sendJson } from "../http.js";
import type { RouteCtx } from "./context.js";

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function agentOptions(workspace: string) {
  return {
    workspace,
    confirm: async () => false as const,
    extractMemory: false,
  };
}

function introducedBlockingFindings(
  before: ReadonlySet<string>,
  target: Finding,
  after: Finding[],
): string[] {
  return after
    .filter((finding) => !before.has(finding.id) && SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[target.severity])
    .map((finding) => finding.id);
}

export async function handle(ctx: RouteCtx): Promise<boolean> {
  await routes(ctx);
  return ctx.res.headersSent;
}

async function routes(ctx: RouteCtx): Promise<void> {
  const { req, res, url, method, segs, workspace, rest } = ctx;
  const path = url.pathname;

  if (method === "GET" && path === "/api/security") {
    return sendJson(res, 200, buildSecurityEvidencePackage(workspace));
  }

  if (method === "POST" && path === "/api/security/scan") {
    const body = await readJsonBody(req, res, { emptyOk: true });
    if (body === undefined) return;
    const maxFindings = (body as { maxFindings?: unknown } | null)?.maxFindings;
    if (
      maxFindings !== undefined &&
      (typeof maxFindings !== "number" || !Number.isSafeInteger(maxFindings) || maxFindings < 1 || maxFindings > 100)
    ) {
      return sendApiError(res, 400, "bad_request", "maxFindings must be an integer from 1 to 100");
    }
    try {
      const result = await rest.coordinator.withRepository(workspace, async () => {
        const handle = await rest.createAgent(agentOptions(workspace));
        try {
          return await scanRepository({ workspace, agent: handle.agent, ...(maxFindings ? { maxFindings } : {}) });
        } finally {
          handle.dispose();
        }
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendApiError(res, 502, "security_scan_failed", errorMessage(error));
    }
  }

  if (method === "POST" && path === "/api/security/threat-model") {
    try {
      const threatModel = await rest.coordinator.withRepository(workspace, async () => {
        const handle = await rest.createAgent(agentOptions(workspace));
        try {
          return await generateThreatModel({ workspace, agent: handle.agent });
        } finally {
          handle.dispose();
        }
      });
      return sendJson(res, 200, threatModel);
    } catch (error) {
      return sendApiError(res, 502, "threat_model_failed", errorMessage(error));
    }
  }

  if (method === "POST" && segs.length === 5 && segs[1] === "security" && segs[2] === "findings" && segs[4] === "status") {
    const findingId = segs[3]!;
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { status, reason } = (body ?? {}) as { status?: unknown; reason?: unknown };
    if (typeof status !== "string" || !(FINDING_STATUSES as readonly string[]).includes(status)) {
      return sendApiError(res, 400, "bad_request", `status must be one of: ${FINDING_STATUSES.join(", ")}`);
    }
    if (reason !== undefined && typeof reason !== "string") {
      return sendApiError(res, 400, "bad_request", "reason must be a string");
    }
    if (!getFinding(workspace, findingId)) {
      return sendApiError(res, 404, "not_found", `finding not found: ${findingId}`);
    }
    try {
      const finding = await rest.coordinator.withRepository(workspace, async () =>
        changeFindingStatus(workspace, findingId, status as (typeof FINDING_STATUSES)[number], reason?.trim() || "status changed in Security Center"),
      );
      return sendJson(res, 200, finding);
    } catch (error) {
      return sendApiError(res, 409, "conflict", errorMessage(error));
    }
  }

  if (method === "POST" && segs.length === 5 && segs[1] === "security" && segs[2] === "findings" && segs[4] === "fix") {
    const findingId = segs[3]!;
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { verifyCommand, lintCommand, maxCostUsd } = (body ?? {}) as {
      verifyCommand?: unknown;
      lintCommand?: unknown;
      maxCostUsd?: unknown;
    };
    if (typeof verifyCommand !== "string" || verifyCommand.trim() === "") {
      return sendApiError(res, 400, "bad_request", "verifyCommand must be a non-empty string");
    }
    if (lintCommand !== undefined && typeof lintCommand !== "string") {
      return sendApiError(res, 400, "bad_request", "lintCommand must be a string");
    }
    if (typeof maxCostUsd !== "number" || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
      return sendApiError(res, 400, "bad_request", "maxCostUsd must be a finite positive number");
    }
    const target = getFinding(workspace, findingId);
    if (!target) return sendApiError(res, 404, "not_found", `finding not found: ${findingId}`);

    try {
      const result = await rest.coordinator.withRepository(workspace, async () => {
        const before = buildSecurityEvidencePackage(workspace);
        const beforeIds = new Set(before.findings.map((finding) => finding.id));
        const fix = startFixAttempt(workspace, findingId);
        let agentCompleted = false;
        let budgetExceeded = false;
        let commands: Awaited<ReturnType<typeof runProjectSecurityChecks>> = [];
        let verificationScan: Awaited<ReturnType<typeof scanRepository>> | undefined;
        try {
          const controller = new AbortController();
          const handle = await rest.createAgent({ ...agentOptions(workspace), signal: controller.signal });
          try {
            for await (const event of handle.agent.runTask({
              projectPath: workspace,
              task: buildFindingFixPrompt(target),
              mode: "edit",
              approvalMode: "acceptEdits",
              signal: controller.signal,
            })) {
              if (event.type === "usage.updated" && event.usage.costUsd >= maxCostUsd) {
                budgetExceeded = true;
                controller.abort();
              }
              if (event.type === "session.completed") agentCompleted = !budgetExceeded;
            }
          } finally {
            handle.dispose();
          }
          if (agentCompleted) {
            commands = await runProjectSecurityChecks({
              workspace,
              verifyCommand: verifyCommand.trim(),
              ...(lintCommand?.trim() ? { lintCommand: lintCommand.trim() } : {}),
              sandbox: "workspace-write",
            });
          }
          if (agentCompleted && commands.every((command) => command.exitCode === 0 && !command.timedOut)) {
            const scanHandle = await rest.createAgent(agentOptions(workspace));
            try {
              verificationScan = await scanRepository({ workspace, agent: scanHandle.agent });
            } finally {
              scanHandle.dispose();
            }
          }
        } catch {
          agentCompleted = false;
        }

        const afterFindings = verificationScan?.findings ?? [];
        const findingStillPresent = verificationScan
          ? afterFindings.some((finding) => isSameFindingFamily(target, finding))
          : undefined;
        const completed = completeFixAttempt({
          workspace,
          fix,
          agentCompleted,
          commands,
          ...(verificationScan ? { verificationScan: verificationScan.scan } : {}),
          ...(findingStillPresent !== undefined ? { findingStillPresent } : {}),
          introducedBlockingFindings: verificationScan
            ? introducedBlockingFindings(beforeIds, target, afterFindings)
            : [],
        });
        return { fix: completed, finding: getFinding(workspace, findingId) };
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendApiError(res, 409, "security_fix_failed", errorMessage(error));
    }
  }

  if (method === "GET" && path === "/api/security/export") {
    const format = url.searchParams.get("format") ?? "json";
    if (format !== "json" && format !== "markdown" && format !== "sarif") {
      return sendApiError(res, 400, "bad_request", "format must be json, markdown, or sarif");
    }
    const extension = format === "markdown" ? "md" : format === "sarif" ? "sarif.json" : "json";
    return sendJson(res, 200, {
      format,
      filename: `seekforge-security-report.${extension}`,
      content: renderSecurityExport(workspace, format as SecurityExportFormat),
      disclaimer: "This export is an evidence package, not a certification or guarantee of compliance.",
    });
  }
}
