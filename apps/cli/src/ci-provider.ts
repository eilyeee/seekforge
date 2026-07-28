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

function throwIfCancelled(result: CiCommandResult): void {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ABORT_ERR") throw result.error;
}

/** GitHub CLI adapter behind the provider-neutral Loop CI closure contract. */
export function createGitHubCiProvider(run: CiCommandRunner): LoopCiProvider {
  return {
    id: "github",
    async waitForRequiredChecks(reference, signal) {
      const checks = await run(buildPrChecksArgs(reference), PR_CHECKS_TIMEOUT_MS + 5_000, 1024 * 1024, signal);
      throwIfCancelled(checks);
      if (checks.status === 0 || isNoChecksReported(`${checks.stdout}\n${checks.stderr}`)) return { status: "passed" };
      if ((checks.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
        return { status: "timed_out", detail: `timed out after ${PR_CHECKS_TIMEOUT_MS / 60_000} minutes` };
      }
      return { status: "failed", detail: `${checks.stdout}\n${checks.stderr}`.trim().slice(-8_192) };
    },
    async failedLog(branch, signal) {
      const listed = await run(buildFailedRunListArgs(branch), 30_000, 1024 * 1024, signal);
      throwIfCancelled(listed);
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
      throwIfCancelled(logs);
      if (logs.status !== 0 || logs.stdout.trim() === "") return undefined;
      return logs.stdout.slice(0, CI_LOG_FEEDBACK_LIMIT);
    },
  };
}

function findFailedGitLabJobId(value: unknown, depth = 0): number | undefined {
  if (depth > 5 || value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 256)) {
      const id = findFailedGitLabJobId(item, depth + 1);
      if (id !== undefined) return id;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.status === "failed" && Number.isSafeInteger(record.id) && (record.id as number) > 0) {
    return record.id as number;
  }
  for (const key of ["jobs", "pipelines", "pipeline", "data"] as const) {
    const id = findFailedGitLabJobId(record[key], depth + 1);
    if (id !== undefined) return id;
  }
  return undefined;
}

/** GitLab CLI adapter behind the same provider-neutral Loop CI closure contract. */
export function createGitLabCiProvider(run: CiCommandRunner): LoopCiProvider {
  return {
    id: "gitlab",
    async waitForRequiredChecks(reference, signal) {
      const checks = await run(
        ["ci", "status", "--branch", reference, "--wait", "--compact"],
        PR_CHECKS_TIMEOUT_MS + 5_000,
        1024 * 1024,
        signal,
      );
      throwIfCancelled(checks);
      if (checks.status === 0) return { status: "passed" };
      if ((checks.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
        return { status: "timed_out", detail: `timed out after ${PR_CHECKS_TIMEOUT_MS / 60_000} minutes` };
      }
      return { status: "failed", detail: `${checks.stdout}\n${checks.stderr}`.trim().slice(-8_192) };
    },
    async failedLog(branch, signal) {
      const listed = await run(
        ["ci", "get", "--branch", branch, "--status", "failed", "--with-job-details", "--output", "json"],
        30_000,
        1024 * 1024,
        signal,
      );
      throwIfCancelled(listed);
      if (listed.status !== 0) return undefined;
      let value: unknown;
      try {
        value = JSON.parse(listed.stdout) as unknown;
      } catch {
        return undefined;
      }
      const jobId = findFailedGitLabJobId(value);
      if (jobId === undefined) return undefined;
      const logs = await run(
        ["ci", "trace", String(jobId), "--branch", branch],
        60_000,
        CI_LOG_FEEDBACK_LIMIT * 4,
        signal,
      );
      throwIfCancelled(logs);
      if (logs.status !== 0 || logs.stdout.trim() === "") return undefined;
      return logs.stdout.slice(0, CI_LOG_FEEDBACK_LIMIT);
    },
  };
}
