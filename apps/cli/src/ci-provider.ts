import {
  buildFailedRunListArgs,
  buildFailedRunLogArgs,
  buildPrChecksArgs,
  CI_LOG_FEEDBACK_LIMIT,
  isNoChecksReported,
  PR_CHECKS_TIMEOUT_MS,
} from "./resolve.js";

export type CiCommandResult = { status: number | null; stdout: string; stderr: string; error?: Error };
export type CiCheckOutcome = { status: "passed" | "failed" | "timed_out"; detail?: string };

export interface LoopCiProvider {
  readonly id: string;
  waitForRequiredChecks(reference: string, signal: AbortSignal): Promise<CiCheckOutcome>;
  failedLog(branch: string, signal: AbortSignal): Promise<string | undefined>;
}

export type CiCommandRunner = (
  args: string[],
  timeoutMs: number,
  maxBuffer: number,
  signal: AbortSignal,
) => Promise<CiCommandResult>;

/** GitHub CLI adapter behind the provider-neutral Loop CI closure contract. */
export function createGitHubCiProvider(run: CiCommandRunner): LoopCiProvider {
  return {
    id: "github",
    async waitForRequiredChecks(reference, signal) {
      const checks = await run(buildPrChecksArgs(reference), PR_CHECKS_TIMEOUT_MS + 5_000, 1024 * 1024, signal);
      if (checks.status === 0 || isNoChecksReported(`${checks.stdout}\n${checks.stderr}`)) return { status: "passed" };
      if ((checks.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
        return { status: "timed_out", detail: `timed out after ${PR_CHECKS_TIMEOUT_MS / 60_000} minutes` };
      }
      return { status: "failed", detail: `${checks.stdout}\n${checks.stderr}`.trim().slice(-8_192) };
    },
    async failedLog(branch, signal) {
      const listed = await run(buildFailedRunListArgs(branch), 30_000, 1024 * 1024, signal);
      if (listed.status !== 0) return undefined;
      let value: unknown;
      try {
        value = JSON.parse(listed.stdout) as unknown;
      } catch {
        return undefined;
      }
      if (!Array.isArray(value) || value.length === 0 || typeof value[0] !== "object" || value[0] === null) {
        return undefined;
      }
      const runId = (value[0] as Record<string, unknown>).databaseId;
      if (!Number.isSafeInteger(runId) || (runId as number) <= 0) return undefined;
      const logs = await run(buildFailedRunLogArgs(runId as number), 60_000, CI_LOG_FEEDBACK_LIMIT * 4, signal);
      if (logs.status !== 0 || logs.stdout.trim() === "") return undefined;
      return logs.stdout.slice(0, CI_LOG_FEEDBACK_LIMIT);
    },
  };
}
