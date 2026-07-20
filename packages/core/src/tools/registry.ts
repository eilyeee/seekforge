import type { z } from "zod";
import type { PermissionName, ToolCall, ToolDefinitionForModel, ToolResult } from "@seekforge/shared";
import type { ToolContext, ToolDispatcher } from "./index.js";
import { ToolError } from "./errors.js";
import { zodToJsonSchema } from "./json-schema.js";
import { enforcePermission, type PermissionDecision } from "./permissions.js";
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
  run: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolRunOutput>;
};

/** Erase the schema type parameter so specs fit into a heterogeneous registry. */
export function defineTool<S extends z.ZodTypeAny>(spec: ToolSpec<S>): ToolSpec {
  return spec as unknown as ToolSpec;
}

export function createDispatcher(tools: ToolSpec[]): ToolDispatcher {
  const byName = new Map(tools.map((t) => [t.name, t]));

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
      let result: ToolResult;

      const fail = (code: string, message: string, detail?: unknown): ToolResult => ({
        ok: false,
        error: { code, message, ...(detail !== undefined ? { detail } : {}) },
      });

      const tool = byName.get(call.name);
      if (!tool) {
        result = fail("unknown_tool", `Unknown tool: ${call.name}`);
      } else {
        const parsed = tool.schema.safeParse(call.arguments ?? {});
        if (!parsed.success) {
          result = fail("invalid_args", `Invalid arguments for ${call.name}`, parsed.error.issues);
        } else {
          effectiveArgs = parsed.data;
          classified = tool.classify(parsed.data as never, ctx);
          permission = classified.permission;
          const outcome = await enforcePermission(call.name, classified, ctx);
          decision = outcome.decision;
          if (!outcome.allowed) {
            result = fail(outcome.errorCode, outcome.errorMessage);
          } else {
            // Thread per-hunk selection from the permission outcome onto the
            // tool context so apply_patch.run can filter edits. Cleared by
            // the caller after each execute (not persisted across calls).
            ctx.selectedHunks = outcome.selectedHunks;
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
                  const reClassified = tool.classify(reparsed.data as never, ctx);
                  const reCheck = await enforcePermission(call.name, reClassified, ctx);
                  classified = reClassified;
                  permission = reClassified.permission;
                  decision = reCheck.decision;
                  if (!reCheck.allowed) updatedDenied = fail(reCheck.errorCode, reCheck.errorMessage);
                  else ctx.selectedHunks = reCheck.selectedHunks;
                }
              }
              if (updatedDenied) {
                result = updatedDenied;
              } else {
                try {
                  const out = await tool.run(runArgs as never, ctx);
                  result = { ok: true, data: out.data, ...(out.meta ? { meta: out.meta } : {}) };
                } catch (err) {
                  if (err instanceof ToolError) {
                    result = fail(err.code, err.message, err.detail);
                  } else {
                    result = fail("internal_error", err instanceof Error ? err.message : String(err));
                  }
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
            // Clear per-hunk selection so it never leaks to the next call.
            delete ctx.selectedHunks;
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
