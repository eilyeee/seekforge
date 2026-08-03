import type { z } from "zod";
import type { PermissionName, ToolCall, ToolDefinitionForModel, ToolResult } from "@seekforge/shared";
import type { ToolContext, ToolDispatcher } from "./index.js";
import { ToolError } from "./errors.js";
import { zodToJsonSchema } from "./json-schema.js";
import { denyBeforePrompt, enforcePermission, type PermissionDecision, type PermissionRefusal } from "./permissions.js";
import { runHooks, type HookPayload } from "../hooks/index.js";

/** Result of classifying one concrete call before permission enforcement. */
export type ClassifiedCall = {
  permission: PermissionName;
  /** Human-readable summary for the confirmation prompt. */
  description: string;
  /** Raw command, when the call runs a command. MUST be shown to the user verbatim. */
  command?: string;
  /** Raw path, when the call touches a file. MUST be shown to the user verbatim. */
  path?: string;
  /** For "execute": the command matched an allowlist and may run without prompting. */
  allowlisted?: boolean;
  /**
   * Edit-review preview (write tools): unified diff of current → proposed
   * content. Forwarded verbatim onto the PermissionRequest so frontends can
   * render an Accept/Reject diff review. Best-effort; omitted on any failure.
   */
  preview?: { path: string; diff: string };
  /**
   * Per-edit hunks for multi-edit apply_patch calls, forwarded onto the
   * PermissionRequest. Populated by apply_patch.classify when >1 edit;
   * single-edit calls omit this so frontends keep their old behavior.
   */
  hunks?: { index: number; preview: string }[];
};

/**
 * What an async `prepare` step contributes before permission enforcement.
 *
 * `classify` is synchronous, which is right for tools whose diff is a pure
 * function of their arguments and the file on disk. A tool whose effect is only
 * known after I/O — a language server deciding which files a rename touches —
 * cannot produce a review payload there, and the user would be asked to approve
 * a write they cannot see. `prepare` is where that tool does the work.
 */
export type PreparedCall = {
  /**
   * Merged over the classification for the confirmation prompt. Deliberately
   * cannot carry `permission`: the level is decided by `classify`, before any
   * of this ran, so a tool cannot lower its own gate with information it went
   * and fetched.
   */
  review?: Partial<Pick<ClassifiedCall, "description" | "path" | "command" | "preview" | "hunks">>;
  /**
   * Handed to `run` as `ctx.prepared`, so the work behind the preview is not
   * repeated — and so the write applies exactly what the user approved.
   */
  state?: unknown;
};

export type ToolRunOutput = {
  data: unknown;
  meta?: ToolResult["meta"];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolSpec<S extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  description: string;
  schema: S;
  /**
   * Raw JSON Schema advertised to the model instead of zodToJsonSchema(schema).
   * Used by MCP tools, whose servers own the real schema; `schema` then only
   * does permissive local validation.
   */
  parametersOverride?: Record<string, unknown>;
  classify: (args: z.infer<S>, ctx: ToolContext) => ClassifiedCall;
  /**
   * Optional async step between `classify` and permission enforcement, for a
   * tool that must do I/O to know what it is about to do. It may enrich the
   * review payload and hand state to `run`; it may not change the permission
   * level. Throwing here fails the call outright — better than prompting for a
   * write that was never going to succeed.
   */
  prepare?: (args: z.infer<S>, ctx: ToolContext) => Promise<PreparedCall>;
  run: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolRunOutput>;
};

/** Erase the schema type parameter so specs fit into a heterogeneous registry. */
export function defineTool<S extends z.ZodTypeAny>(spec: ToolSpec<S>): ToolSpec {
  return spec as unknown as ToolSpec;
}

export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function createDispatcher(tools: ToolSpec[]): ToolDispatcher {
  const byName = new Map<string, ToolSpec>();
  for (const tool of tools) {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new RangeError(`Invalid tool name ${JSON.stringify(tool.name)}; expected 1-64 letters, digits, _ or -`);
    }
    if (byName.has(tool.name)) throw new RangeError(`Duplicate tool name: ${tool.name}`);
    byName.set(tool.name, tool);
  }

  return {
    list(): ToolDefinitionForModel[] {
      return tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parametersOverride ?? zodToJsonSchema(t.schema),
      }));
    },

    async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
      const started = Date.now();
      const startedAt = new Date(started).toISOString();
      let decision: PermissionDecision | "not_evaluated" = "not_evaluated";
      let permission: PermissionName | undefined;
      let classified: ClassifiedCall | undefined;
      let effectiveArgs: unknown = call.arguments;
      let inputRewritten = false;
      let preparedState: unknown;
      let result: ToolResult;

      const fail = (code: string, message: string, detail?: unknown): ToolResult => ({
        ok: false,
        error: { code, message, ...(detail !== undefined ? { detail } : {}) },
      });

      /**
       * Classify, then let an async `prepare` enrich the review payload. The
       * permission level is re-asserted from the classification afterwards so
       * the enrichment cannot change what the user is being asked to approve.
       *
       * A call the policy refuses out of hand never reaches `prepare`: that
       * step does I/O to describe the change, and a tool the run has denied
       * must do nothing at all. The refusal is returned so the caller reports
       * it verbatim instead of re-deriving it.
       */
      const classifyAndPrepare = async (
        spec: ToolSpec,
        args: unknown,
      ): Promise<{ classified: ClassifiedCall; refused?: PermissionRefusal }> => {
        const base = spec.classify(args as never, ctx);
        if (!spec.prepare) return { classified: base };
        const refused = denyBeforePrompt(call.name, base, ctx);
        if (refused) return { classified: base, refused };
        const prepared = await spec.prepare(args as never, ctx);
        preparedState = prepared.state;
        // Only what prepare actually supplied is merged: a spread would let an
        // explicitly-undefined field erase the classification's own value.
        const classified: ClassifiedCall = { ...base };
        for (const [key, value] of Object.entries(prepared.review ?? {})) {
          if (value !== undefined) (classified as Record<string, unknown>)[key] = value;
        }
        classified.permission = base.permission;
        return { classified };
      };

      const toolError = (err: unknown): ToolResult =>
        err instanceof ToolError
          ? fail(err.code, err.message, err.detail)
          : fail("internal_error", err instanceof Error ? err.message : String(err));

      const tool = byName.get(call.name);
      const parsed = tool?.schema.safeParse(call.arguments ?? {});
      // Classify (and prepare) up front so a prepare failure can be reported
      // without asking the user to approve a write that was never going to
      // happen — while every call still ends at the shared meta/log epilogue.
      let prepareFailure: ToolResult | undefined;
      let refusedBeforePrepare: PermissionRefusal | undefined;
      if (tool && parsed?.success) {
        effectiveArgs = parsed.data;
        try {
          const outcome = await classifyAndPrepare(tool, parsed.data);
          classified = outcome.classified;
          refusedBeforePrepare = outcome.refused;
        } catch (err) {
          prepareFailure = toolError(err);
        }
      }

      if (!tool) {
        result = fail("unknown_tool", `Unknown tool: ${call.name}`);
      } else {
        if (!parsed?.success) {
          result = fail("invalid_args", `Invalid arguments for ${call.name}`, parsed?.error.issues);
        } else if (prepareFailure || !classified) {
          result = prepareFailure ?? fail("internal_error", `${call.name} produced no classification`);
        } else if (refusedBeforePrepare) {
          permission = classified.permission;
          decision = refusedBeforePrepare.decision;
          result = fail(refusedBeforePrepare.errorCode, refusedBeforePrepare.errorMessage);
        } else {
          permission = classified.permission;
          const outcome = await enforcePermission(call.name, classified, ctx);
          decision = outcome.decision;
          if (!outcome.allowed) {
            result = fail(outcome.errorCode, outcome.errorMessage);
          } else {
            // selectedHunks is call-local. A dispatcher can be used concurrently
            // by SDK consumers, so mutating the shared context lets one approval
            // alter another in-flight apply_patch call.
            const runCtx: ToolContext = { ...ctx };
            delete runCtx.selectedHunks;
            delete runCtx.prepared;
            if (outcome.selectedHunks !== undefined) runCtx.selectedHunks = [...outcome.selectedHunks];
            if (preparedState !== undefined) runCtx.prepared = preparedState;
            // Hooks fire only for calls that passed permission enforcement.
            // Model-controlled content goes into the payload (stdin), never
            // into the hook command line.
            const hookPayload: HookPayload = {
              sessionId: ctx.sessionId,
              workspace: ctx.workspace,
              toolName: call.name,
              args: parsed.data,
              ...(classified.command !== undefined ? { command: classified.command } : {}),
              ...(classified.path !== undefined ? { path: classified.path } : {}),
            };
            const preOutcomes = await runHooks("preToolUse", ctx.hooks?.preToolUse, hookPayload, {
              signal: ctx.signal,
            });
            const blockedBy = preOutcomes.find((o) => !o.ok);
            if (ctx.signal?.aborted) {
              result = fail("cancelled", "Tool call cancelled");
            } else if (blockedBy) {
              result = fail(
                "hook_blocked",
                `Blocked by preToolUse hook${blockedBy.timedOut ? " (timed out)" : ""}: ` +
                  (blockedBy.systemMessage || blockedBy.outputTail || `exit ${blockedBy.exitCode}`),
              );
            } else {
              // A non-denying preToolUse hook may rewrite the tool's arguments
              // via updatedInput. Re-validate against the schema first; an
              // invalid rewrite must not silently execute the original call.
              let runArgs: unknown = parsed.data;
              let updatedDenied: ToolResult | undefined;
              const updated = preOutcomes.find((o) => o.updatedInput !== undefined)?.updatedInput;
              if (updated !== undefined) {
                const reparsed = tool.schema.safeParse(updated);
                if (!reparsed.success) {
                  updatedDenied = fail(
                    "invalid_hook_args",
                    `preToolUse hook returned invalid arguments for ${call.name}`,
                    reparsed.error.issues,
                  );
                } else {
                  runArgs = reparsed.data;
                  effectiveArgs = reparsed.data;
                  inputRewritten = true;
                  // The rewritten args can change the path/command, so re-classify
                  // and re-enforce permission — a hook must not be able to smuggle
                  // a denylisted/forbidden call past the gate via updatedInput.
                  // prepare runs again for the same reason: the state handed to
                  // run() must describe the arguments actually being run.
                  let reClassified: ClassifiedCall | undefined;
                  try {
                    const reOutcome = await classifyAndPrepare(tool, reparsed.data);
                    if (reOutcome.refused) {
                      classified = reOutcome.classified;
                      permission = reOutcome.classified.permission;
                      decision = reOutcome.refused.decision;
                      updatedDenied = fail(reOutcome.refused.errorCode, reOutcome.refused.errorMessage);
                    } else {
                      reClassified = reOutcome.classified;
                    }
                  } catch (err) {
                    updatedDenied = toolError(err);
                  }
                  if (reClassified) {
                    const reCheck = await enforcePermission(call.name, reClassified, ctx);
                    classified = reClassified;
                    permission = reClassified.permission;
                    decision = reCheck.decision;
                    if (!reCheck.allowed) updatedDenied = fail(reCheck.errorCode, reCheck.errorMessage);
                    else {
                      delete runCtx.selectedHunks;
                      delete runCtx.prepared;
                      if (reCheck.selectedHunks !== undefined) runCtx.selectedHunks = [...reCheck.selectedHunks];
                      if (preparedState !== undefined) runCtx.prepared = preparedState;
                    }
                  }
                }
              }
              if (updatedDenied) {
                result = updatedDenied;
              } else {
                try {
                  const out = await tool.run(runArgs as never, runCtx);
                  result = { ok: true, data: out.data, ...(out.meta ? { meta: out.meta } : {}) };
                } catch (err) {
                  result = toolError(err);
                }
                // postToolUse is advisory: failures log to stderr, never block.
                // It sees the args actually run (post-updatedInput); the payload
                // carries ok/errorCode only, never raw tool output.
                await runHooks(
                  "postToolUse",
                  ctx.hooks?.postToolUse,
                  {
                    sessionId: ctx.sessionId,
                    workspace: ctx.workspace,
                    toolName: call.name,
                    args: runArgs,
                    ...(classified?.command !== undefined ? { command: classified.command } : {}),
                    ...(classified?.path !== undefined ? { path: classified.path } : {}),
                    result: { ok: result.ok, errorCode: result.error?.code ?? null },
                  },
                  { signal: ctx.signal },
                );
                if (ctx.signal?.aborted) result = fail("cancelled", "Tool call cancelled");
              }
            }
          }
        }
      }

      const ended = Date.now();
      result.meta = {
        ...result.meta,
        durationMs: ended - started,
        ...(permission ? { permission } : {}),
        ...(classified?.command !== undefined ? { command: classified.command } : {}),
        ...(classified?.path !== undefined ? { path: classified.path } : {}),
      };

      ctx.log?.({
        toolName: call.name,
        args: effectiveArgs,
        ...(inputRewritten ? { originalArgs: call.arguments } : {}),
        ok: result.ok,
        errorCode: result.error?.code ?? null,
        durationMs: ended - started,
        permissionDecision: decision,
        startedAt,
        endedAt: new Date(ended).toISOString(),
      });

      return result;
    },
  };
}
