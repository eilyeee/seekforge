/**
 * Process-launcher Graph executor (Track E: remote / isolated execution).
 *
 * A `remote` Graph node delegates to a {@link GraphExecutionAdapter} that the
 * HOST registers. Until now the repository shipped none, so `remote` was a
 * contract with no implementation. This module turns any launcher that can run
 * one `seekforge run` somewhere else — a container, a machine you own over ssh —
 * into an adapter, and owns everything the Graph contract asks of a remote
 * executor that is NOT transport-specific:
 *
 * - the JSON result envelope is the node's usage report (see the cost rule below);
 * - a stable idempotency key maps to a committed local result (`recover`), so a
 *   crash between "the remote run finished" and "the checkpoint was written"
 *   does not run the work twice;
 * - a per-attempt fence, when the transport has one (`reserve`);
 * - cooperative cancellation, declared ONLY when the transport can actually stop
 *   an already-dispatched attempt (`cancel` / `supportsCancellation`);
 * - result provenance, verified only where it can be (`verifyResult`).
 *
 * ── The cost rule ───────────────────────────────────────────────────────────
 * A Graph budget is allocated from what its nodes report. A node that cannot
 * report is therefore not free — it is unmeasured, and the two must never look
 * alike. So:
 *
 *   1. The launcher asks the run for `--output-format json`, whose result
 *      envelope carries `total_cost_usd` and `usage`. That is the report, and it
 *      works across ssh too: the remote host prints its own usage down the same
 *      channel that carried the command.
 *   2. If the envelope reports usage, it becomes the node's `costUsd` /
 *      `tokensUsed`, and `costAccount` records WHOSE money it was: `"local"`
 *      when the run used this machine's credentials, `"remote"` when it used
 *      credentials this machine never sees (the ssh case).
 *   3. If no usage came back and the Graph declared a cost or token budget, the
 *      node FAILS non-retryably. Retrying would spend again, just as blindly.
 *   4. If no usage came back and there is no budget, the node reports
 *      `costUsd: 0` together with `costAccounting: "unreported"` in its output,
 *      so nothing downstream can read the zero as a measurement.
 *
 * Trust is never granted here. This module builds an adapter; only a host that
 * explicitly registers it under an executor id makes it `trusted`.
 */

import { spawn as spawnProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { clipLine, lastNonEmptyLine } from "@seekforge/shared/format";
import { onAbortOnce } from "../util/abort.js";
import { hasOnlyKeys, isRecord } from "../util/guards.js";
import { killProcessTree } from "../util/process-tree.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import type { GraphExecutionAdapter, GraphFunctionContext, GraphFunctionResult } from "./graph-execution-contract.js";
import { GraphNodeExecutionError, GraphNodeNonRetryableError } from "./graph-execution-errors.js";
import { isValidLoopDagId } from "./loop-dag-validation.js";

/** One launch: a binary and its argv. Built by the transport, run by this module. */
export type GraphRemoteRunnerCommand = { file: string; args: readonly string[] };

/** Everything a transport needs to build the argv for one Graph node attempt. */
export type GraphRemoteRunnerRequest = {
  readonly nodeId: string;
  readonly task: string;
  /** The node's physical local workspace. A transport that runs elsewhere may ignore it. */
  readonly workspace: string;
  /** Stable for one logical attempt across resume; the transport may derive a fence from it. */
  readonly idempotencyKey: string;
  /** Present only when {@link GraphRemoteRunnerTransport.fencingToken} produced one. */
  readonly fencingToken?: string;
  /** Remaining Graph cost budget, passed down so the remote run enforces it too. */
  readonly maxCostUsd?: number;
  /** Node timeout in seconds, passed down so the remote run stops on its own. */
  readonly maxDurationSeconds?: number;
};

/**
 * The transport-specific half of a remote executor: how to launch, fence, and
 * cancel one run. Capabilities are opt-in — a transport that cannot stop a
 * dispatched attempt simply omits `cancelCommand`, and the adapter then does not
 * claim `supportsCancellation`, so preflight rejects nodes that require it.
 */
export type GraphRemoteRunnerTransport = {
  /** Stable transport name, recorded in the node output. */
  readonly name: string;
  /**
   * Whose credentials pay for the run. `"local"` means this machine's provider
   * key reached the run (a container with the key forwarded by name);
   * `"remote"` means the run used credentials this machine never sees.
   */
  readonly costAccount: "local" | "remote";
  /**
   * True when the run writes its session into the node's local workspace, which
   * is the only case where the reported session id can be verified from here.
   */
  readonly sessionIsLocal: boolean;
  /** Builds the argv that executes one task and prints the JSON result envelope. */
  readonly command: (request: GraphRemoteRunnerRequest) => GraphRemoteRunnerCommand;
  /**
   * Derives a deterministic per-attempt fence (e.g. a container name the daemon
   * refuses to duplicate). Omit when the transport has no such mechanism —
   * inventing a token that fences nothing would be worse than having none.
   */
  readonly fencingToken?: (request: GraphRemoteRunnerRequest) => string;
  /** Stops an already-dispatched attempt. Omit unless the transport really can. */
  readonly cancelCommand?: (request: GraphRemoteRunnerRequest) => GraphRemoteRunnerCommand;
  /** Best-effort cleanup of transport state left by a finished attempt. */
  readonly releaseCommand?: (request: GraphRemoteRunnerRequest) => GraphRemoteRunnerCommand;
};

export type GraphRemoteRunnerProcessResult = { exitCode: number; stdout: string; stderr: string };

/** Injection point: replaced in tests so the adapter is verifiable without Docker or ssh. */
export type GraphRemoteRunnerSpawn = (
  command: GraphRemoteRunnerCommand,
  options: { signal?: AbortSignal },
) => Promise<GraphRemoteRunnerProcessResult>;

export type GraphRemoteRunnerAdapterOptions = {
  /** Adapter-local concurrency ceiling reported to the scheduler (1..1024). */
  capacity?: number;
  /** Cross-process ceiling shared by every Graph in the workspace (1..512). */
  workspaceCapacity?: number;
  spawn?: GraphRemoteRunnerSpawn;
};

/** Descriptor a host can read back off a built adapter (the contract itself has no such field). */
export type GraphRemoteRunnerDescriptor = {
  readonly name: string;
  readonly costAccount: "local" | "remote";
  readonly sessionIsLocal: boolean;
};

export type GraphRemoteRunnerAdapter = GraphExecutionAdapter & {
  /** Transport provenance, for hosts that need to explain what they registered. */
  readonly runner: GraphRemoteRunnerDescriptor;
};

/** The `--output-format json` result envelope, reduced to what a Graph node needs. */
export type GraphRemoteRunEnvelope = {
  isError: boolean;
  summary: string;
  sessionId?: string;
  /** Present only when the run actually reported usage; absent means "unmeasured". */
  costUsd?: number;
  tokensUsed?: number;
};

const JOURNAL_DIR = ".seekforge/graph-remote-results";
const MAX_JOURNAL_ENTRIES = 256;
const MAX_JOURNAL_BYTES = 64 * 1024;
const MAX_CAPTURE_CHARS = 1_000_000;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_FAILURE_CHARS = 500;
const MAX_ENVELOPE_CANDIDATES = 8;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function parseRecord(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function readReportedUsage(value: Record<string, unknown>): { costUsd: number; tokensUsed: number } | undefined {
  const usage = value.usage;
  // `total_cost_usd` defaults to 0 in the envelope even when the run produced no
  // report at all, so the usage block — not the cost field — decides whether
  // anything was measured.
  if (!isRecord(usage)) return undefined;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (
    !Number.isSafeInteger(input) ||
    (input as number) < 0 ||
    !Number.isSafeInteger(output) ||
    (output as number) < 0
  ) {
    return undefined;
  }
  const cost = value.total_cost_usd;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return undefined;
  return { costUsd: cost, tokensUsed: (input as number) + (output as number) };
}

/**
 * PURE: read the run's result envelope out of captured stdout.
 *
 * `--output-format json` pretty-prints exactly one object at the end of the
 * stream, so the whole capture is tried first and then each trailing document
 * that starts a new object at column 0. A run that printed nothing parseable
 * returns undefined, which the cost rule treats as "unmeasured", never as zero.
 */
export function parseGraphRemoteRunEnvelope(stdout: string): GraphRemoteRunEnvelope | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  const candidates: string[] = [trimmed];
  for (
    let index = trimmed.lastIndexOf("\n{");
    index > 0 && candidates.length < MAX_ENVELOPE_CANDIDATES;
    index = trimmed.lastIndexOf("\n{", index - 1)
  ) {
    candidates.push(trimmed.slice(index + 1));
  }
  for (const candidate of candidates) {
    const value = parseRecord(candidate);
    if (value === undefined || value.type !== "result") continue;
    const usage = readReportedUsage(value);
    const sessionId = value.session_id;
    return {
      isError: value.is_error === true,
      summary: typeof value.result === "string" ? clipLine(value.result, MAX_SUMMARY_CHARS) : "",
      ...(typeof sessionId === "string" && SESSION_ID_RE.test(sessionId) ? { sessionId } : {}),
      ...(usage ?? {}),
    };
  }
  return undefined;
}

type JournalEntry = {
  version: 1;
  executor: string;
  idempotencyKey: string;
  output: unknown;
  costUsd: number;
  tokensUsed: number;
  committedAt: string;
};

function journalFile(executor: string, idempotencyKey: string): string {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
  return `${JOURNAL_DIR}/${executor}-${digest}.json`;
}

function validJournalEntry(value: unknown, executor: string, idempotencyKey: string): value is JournalEntry {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["version", "executor", "idempotencyKey", "output", "costUsd", "tokensUsed", "committedAt"]) &&
    value.version === 1 &&
    value.executor === executor &&
    value.idempotencyKey === idempotencyKey &&
    typeof value.costUsd === "number" &&
    Number.isFinite(value.costUsd) &&
    value.costUsd >= 0 &&
    Number.isSafeInteger(value.tokensUsed) &&
    (value.tokensUsed as number) >= 0 &&
    typeof value.committedAt === "string" &&
    Number.isFinite(Date.parse(value.committedAt))
  );
}

function readJournal(workspace: string, executor: string, idempotencyKey: string): GraphFunctionResult | undefined {
  let raw: string | undefined;
  try {
    raw = readWorkspaceStateFile(workspace, journalFile(executor, idempotencyKey), MAX_JOURNAL_BYTES);
  } catch {
    // A journal that cannot be read is a journal that recovers nothing; the node
    // simply runs again. It must never be the reason a Graph fails.
    return undefined;
  }
  if (raw === undefined) return undefined;
  const value = parseRecord(raw);
  if (!validJournalEntry(value, executor, idempotencyKey)) return undefined;
  return { output: value.output, costUsd: value.costUsd, tokensUsed: value.tokensUsed };
}

/** Keeps the journal directory bounded; the oldest committed results are the least useful. */
function pruneJournal(workspace: string): void {
  try {
    const directory = join(realpathSync(resolve(workspace)), ...JOURNAL_DIR.split("/"));
    const names = readdirSync(directory).filter((name) => name.endsWith(".json"));
    if (names.length <= MAX_JOURNAL_ENTRIES) return;
    const dated = names.map((name) => {
      let modifiedMs = 0;
      try {
        modifiedMs = statSync(join(directory, name)).mtimeMs;
      } catch {
        modifiedMs = 0;
      }
      return { name, modifiedMs };
    });
    dated.sort((left, right) => left.modifiedMs - right.modifiedMs || (left.name < right.name ? -1 : 1));
    for (const entry of dated.slice(0, dated.length - MAX_JOURNAL_ENTRIES)) {
      rmSync(join(directory, entry.name), { force: true });
    }
  } catch {
    // Best effort: a journal that outgrows its cap costs disk, not correctness.
  }
}

function writeJournal(workspace: string, executor: string, idempotencyKey: string, result: GraphFunctionResult): void {
  const entry: JournalEntry = {
    version: 1,
    executor,
    idempotencyKey,
    output: result.output ?? null,
    costUsd: result.costUsd ?? 0,
    tokensUsed: result.tokensUsed ?? 0,
    committedAt: new Date().toISOString(),
  };
  let serialized: string;
  try {
    serialized = `${JSON.stringify(entry)}\n`;
  } catch {
    return;
  }
  if (Buffer.byteLength(serialized) > MAX_JOURNAL_BYTES) return;
  try {
    writeWorkspaceStateFileAtomic(workspace, journalFile(executor, idempotencyKey), serialized);
    pruneJournal(workspace);
  } catch {
    // The result is already returned to the runtime, which checkpoints it. The
    // journal only narrows the crash window, so failing to write one must not
    // fail a node that has already done its work.
  }
}

/** Spawns the launcher, captures bounded stdio, and reaps the tree on abort. */
function spawnCapture(
  command: GraphRemoteRunnerCommand,
  options: { signal?: AbortSignal },
): Promise<GraphRemoteRunnerProcessResult> {
  return new Promise<GraphRemoteRunnerProcessResult>((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Graph remote attempt cancelled before launch"));
      return;
    }
    let child: ReturnType<typeof spawnProcess>;
    try {
      // The provider key is NOT scrubbed from this environment: the container
      // transport forwards it BY NAME (`-e NAME`), so removing it here would
      // silently start a run with no credentials.
      child = spawnProcess(command.file, [...command.args], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE_CHARS) stdout = clipCapture(stdout + outDecoder.write(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE_CHARS) stderr = clipCapture(stderr + errDecoder.write(chunk));
    });
    const detach = onAbortOnce(options.signal, () => {
      killProcessTree(child);
    });
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      detach();
      fn();
    };
    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code, signalName) =>
      settle(() =>
        resolvePromise({
          exitCode: code ?? (signalName ? 143 : 1),
          stdout,
          stderr,
        }),
      ),
    );
  });
}

function clipCapture(value: string): string {
  return value.length > MAX_CAPTURE_CHARS ? value.slice(0, MAX_CAPTURE_CHARS) : value;
}

function requireTask(context: GraphFunctionContext): string {
  const task = context.node.task;
  if (typeof task !== "string" || task.trim().length === 0) {
    throw new GraphNodeNonRetryableError(`Graph remote ${context.node.id} requires a task for its runner executor`);
  }
  return task;
}

function buildRequest(context: GraphFunctionContext, fencingToken?: string): GraphRemoteRunnerRequest {
  const timeoutMs = context.node.timeoutMs;
  return {
    nodeId: context.node.id,
    task: requireTask(context),
    workspace: context.workspace,
    idempotencyKey: context.idempotencyKey,
    ...(fencingToken !== undefined ? { fencingToken } : {}),
    ...(context.costBudgetUsd !== undefined && context.costBudgetUsd > 0 ? { maxCostUsd: context.costBudgetUsd } : {}),
    ...(typeof timeoutMs === "number" && timeoutMs >= 1_000
      ? { maxDurationSeconds: Math.floor(timeoutMs / 1_000) }
      : {}),
  };
}

/**
 * Builds a `GraphExecutionAdapter` around one transport.
 *
 * `executorId` is the id the host will register the adapter under; it also
 * namespaces the idempotency journal, so two transports registered under
 * different ids never recover each other's results. The returned adapter is
 * marked `trusted` because CONSTRUCTING it is already a host decision — nothing
 * a Graph definition, a plugin manifest, or a workspace file can reach builds
 * one. Hosts must still refuse to construct it unless the operator explicitly
 * configured the transport.
 */
export function createGraphRemoteRunnerAdapter(
  executorId: string,
  transport: GraphRemoteRunnerTransport,
  options: GraphRemoteRunnerAdapterOptions = {},
): GraphRemoteRunnerAdapter {
  if (!isValidLoopDagId(executorId)) throw new Error(`Graph remote executor id is invalid: ${executorId}`);
  if (typeof transport.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(transport.name)) {
    throw new Error("Graph remote runner transport name is invalid");
  }
  if (typeof transport.command !== "function") throw new Error("Graph remote runner transport needs a command builder");
  if (
    options.capacity !== undefined &&
    (!Number.isSafeInteger(options.capacity) || options.capacity < 1 || options.capacity > 1_024)
  ) {
    throw new RangeError("Graph remote runner capacity must be an integer from 1 to 1024");
  }
  if (
    options.workspaceCapacity !== undefined &&
    (!Number.isSafeInteger(options.workspaceCapacity) ||
      options.workspaceCapacity < 1 ||
      options.workspaceCapacity > 512)
  ) {
    throw new RangeError("Graph remote runner workspaceCapacity must be an integer from 1 to 512");
  }
  const spawn = options.spawn ?? spawnCapture;

  const runCommand = async (command: GraphRemoteRunnerCommand): Promise<void> => {
    try {
      await spawn(command, {});
    } catch {
      // Cancellation and cleanup are best effort by construction: the attempt is
      // already finished or being abandoned when they run.
    }
  };

  const adapter: GraphRemoteRunnerAdapter = {
    trusted: true,
    locality: "remote",
    protocolVersion: 1,
    ...(transport.cancelCommand ? { supportsCancellation: true } : {}),
    ...(options.capacity !== undefined ? { capacity: options.capacity, active: 0 } : {}),
    ...(options.workspaceCapacity !== undefined ? { workspaceCapacity: options.workspaceCapacity } : {}),
    runner: {
      name: transport.name,
      costAccount: transport.costAccount,
      sessionIsLocal: transport.sessionIsLocal === true,
    },

    recover: (context) => readJournal(context.workspace, executorId, context.idempotencyKey),

    ...(transport.fencingToken
      ? {
          reserve: (context: GraphFunctionContext) => {
            const request = buildRequest(context);
            const fencingToken = transport.fencingToken!(request);
            if (typeof fencingToken !== "string" || fencingToken.length === 0 || fencingToken.length > 256) {
              throw new GraphNodeNonRetryableError(
                `Graph remote ${context.node.id} transport produced an invalid fencing token`,
              );
            }
            return {
              fencingToken,
              release: async () => {
                const release = transport.releaseCommand?.({ ...request, fencingToken });
                if (release) await runCommand(release);
              },
            };
          },
        }
      : {}),

    ...(transport.cancelCommand
      ? {
          cancel: async (context: GraphFunctionContext) => {
            const request = buildRequest(context, context.executorLease?.fencingToken);
            await runCommand(transport.cancelCommand!(request));
          },
        }
      : {}),

    ...(transport.sessionIsLocal
      ? {
          verifyResult: (result: GraphFunctionResult, context: GraphFunctionContext) => {
            // The only provenance this machine can check: a run that claims a
            // session id must have left that session in the node's workspace.
            if (!isRecord(result.output)) return false;
            const sessionId = result.output.sessionId;
            if (sessionId === null || sessionId === undefined) return result.output.costAccounting === "unreported";
            if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return false;
            try {
              return statSync(join(resolve(context.workspace), ".seekforge", "sessions", sessionId)).isDirectory();
            } catch {
              return false;
            }
          },
        }
      : {}),

    execute: async (context: GraphFunctionContext): Promise<GraphFunctionResult> => {
      const request = buildRequest(context, context.executorLease?.fencingToken);
      const command = transport.command(request);
      if (
        !isRecord(command) ||
        typeof command.file !== "string" ||
        command.file.length === 0 ||
        !Array.isArray(command.args) ||
        command.args.some((argument) => typeof argument !== "string")
      ) {
        throw new GraphNodeNonRetryableError(`Graph remote ${context.node.id} transport produced an invalid command`);
      }
      if (options.capacity !== undefined) adapter.active = (adapter.active ?? 0) + 1;
      let run: GraphRemoteRunnerProcessResult;
      try {
        run = await spawn(command, { ...(context.signal ? { signal: context.signal } : {}) });
      } finally {
        if (options.capacity !== undefined) adapter.active = Math.max(0, (adapter.active ?? 1) - 1);
      }
      const envelope = parseGraphRemoteRunEnvelope(run.stdout);
      const budgeted = context.costBudgetUsd !== undefined || context.tokenBudget !== undefined;
      const reported = envelope?.costUsd !== undefined && envelope.tokensUsed !== undefined;
      const usage = reported ? { costUsd: envelope!.costUsd!, tokensUsed: envelope!.tokensUsed! } : undefined;

      if (run.exitCode !== 0 || envelope?.isError === true) {
        const detail =
          envelope && envelope.summary.length > 0
            ? envelope.summary
            : clipLine(lastNonEmptyLine(run.stderr || run.stdout), MAX_FAILURE_CHARS);
        const message = `Graph remote ${context.node.id} ${transport.name} run failed (exit ${run.exitCode})${detail ? `: ${detail}` : ""}`;
        throw new GraphNodeExecutionError(message, {
          costUsd: usage?.costUsd ?? 0,
          tokensUsed: usage?.tokensUsed ?? 0,
          ...(envelope?.sessionId ? { sessionId: envelope.sessionId } : {}),
        });
      }
      if (!reported && budgeted) {
        // Fail closed. Retrying would spend the same unmeasured amount again, so
        // this is not retryable.
        throw new GraphNodeNonRetryableError(
          `Graph remote ${context.node.id} ${transport.name} run reported no usage while a Graph budget is in force; ` +
            `remove the budget or use a runner whose run reports its own cost`,
        );
      }

      const result: GraphFunctionResult = {
        output: {
          runner: transport.name,
          sessionId: envelope?.sessionId ?? null,
          summary: envelope?.summary ?? "",
          costAccounting: reported ? "reported" : "unreported",
          costAccount: transport.costAccount,
        },
        costUsd: usage?.costUsd ?? 0,
        tokensUsed: usage?.tokensUsed ?? 0,
      };
      writeJournal(context.workspace, executorId, context.idempotencyKey, result);
      return result;
    },
  };
  return adapter;
}
