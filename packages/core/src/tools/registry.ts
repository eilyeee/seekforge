import type { z } from "zod";
import type {
  ConfirmResult,
  PermissionName,
  PermissionRequest,
  ToolCall,
  ToolDefinitionForModel,
  ToolResult,
} from "@seekforge/shared";
import type { ToolContext, ToolDispatcher } from "./index.js";
import { ToolError } from "./errors.js";
import { zodToJsonSchema } from "./json-schema.js";
import {
  askRuleMatches,
  denyBeforePrompt,
  enforcePermission,
  type PermissionDecision,
  type PermissionOutcome,
  type PermissionRefusal,
} from "./permissions.js";
import { hasShellControlSyntax } from "./run-command.js";
import {
  hookToolResult,
  permissionRequestAnswer,
  runHooks,
  toolHookFeedback,
  type HookOutcome,
  type HookPayload,
  type HookStage,
  type RunHooksOptions,
} from "../hooks/index.js";

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
  /** Images for the model, carried onto the ToolResult (see ToolResult.images). */
  images?: ToolResult["images"];
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

/**
 * What the audit log records as the call's permission decision: the policy's
 * own decision, or a hook's answer in place of a prompt.
 */
export type DispatchDecision = PermissionDecision | "not_evaluated" | "hook_allowed" | "hook_denied";

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
      let decision: DispatchDecision = "not_evaluated";
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
      const cancelled = (): ToolResult => fail("cancelled", "Tool call cancelled");

      /**
       * Classify, apply the refusals that need nobody's input, then let an
       * async `prepare` enrich the review payload. The permission level is
       * re-asserted from the classification afterwards so the enrichment
       * cannot change what the user is being asked to approve.
       *
       * A call the policy refuses out of hand reaches neither `prepare` nor any
       * hook: prepare does I/O to describe the change, and a tool the run has
       * denied must do nothing at all. The refusal is returned so the caller
       * reports it verbatim instead of re-deriving it.
       */
      const classifyAndPrepare = async (
        spec: ToolSpec,
        args: unknown,
      ): Promise<{ classified: ClassifiedCall; refused?: PermissionRefusal }> => {
        const base = spec.classify(args as never, ctx);
        const refused = denyBeforePrompt(call.name, base, ctx);
        if (refused) return { classified: base, refused };
        if (!spec.prepare) return { classified: base };
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

      // Hooks see model-controlled content only in their payload (stdin,
      // request body, fenced prompt data), never on a command line.
      const hookOpts: RunHooksOptions = {
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(ctx.hookEvaluate ? { evaluate: ctx.hookEvaluate } : {}),
      };
      const hookPayload = (args: unknown, cls: ClassifiedCall): HookPayload => ({
        sessionId: ctx.sessionId,
        workspace: ctx.workspace,
        toolName: call.name,
        args,
        ...(cls.command !== undefined ? { command: cls.command } : {}),
        ...(cls.path !== undefined ? { path: cls.path } : {}),
      });
      const report = (stage: HookStage, outcomes: HookOutcome[]): void => {
        const feedback = toolHookFeedback(stage, outcomes);
        if (feedback) ctx.onHookFeedback?.(feedback);
      };

      /**
       * Permission enforcement with the hooks' answers applied. `hookAllow`
       * answers the prompt the policy would show; `hookAsk` forces one, as a
       * one-call ask rule would. permissionRequest hooks run where the prompt
       * would appear and may answer it for the user. No hook approval answers
       * a prompt a person must see (an ask rule, a preToolUse "ask"), and none
       * covers a compound shell command — the limit allow rules have. The
       * absolute refusals (deny rules, ask mode, dangerous) already ran.
       */
      const enforceWithHooks = async (
        cls: ClassifiedCall,
        args: unknown,
        hookAllow: boolean,
        hookAsk: boolean,
      ): Promise<{ outcome: PermissionOutcome; decision: DispatchDecision }> => {
        const personRequired = hookAsk || askRuleMatches(call.name, cls, ctx);
        const compound = call.name === "run_command" && cls.command !== undefined && hasShellControlSyntax(cls.command);
        const hookMayApprove = !personRequired && !compound;
        let answeredBy: "hook_allowed" | "hook_denied" | undefined;
        let denial = "denied";
        const confirm = async (req: PermissionRequest): Promise<ConfirmResult> => {
          if (hookAllow && hookMayApprove) {
            answeredBy = "hook_allowed";
            return true;
          }
          const answers = await runHooks(
            "permissionRequest",
            ctx.hooks?.permissionRequest,
            { ...hookPayload(args, cls), permission: req.permission, description: req.description },
            hookOpts,
          );
          report("permissionRequest", answers);
          if (ctx.signal?.aborted) return false;
          const answer = permissionRequestAnswer(answers);
          if (answer?.decision === "deny") {
            answeredBy = "hook_denied";
            if (answer.reason) denial = answer.reason;
            return false;
          }
          if (hookMayApprove && answer?.decision === "allow") {
            answeredBy = "hook_allowed";
            return true;
          }
          return ctx.confirm(hookAsk ? { ...req, approvalReason: "hook" } : req);
        };
        const policy = hookAsk
          ? { ...ctx.policy, rules: [{ action: "ask" as const, tool: call.name }, ...(ctx.policy.rules ?? [])] }
          : ctx.policy;
        const outcome = await enforcePermission(call.name, cls, { ...ctx, policy, confirm });
        if (answeredBy === "hook_denied") {
          return {
            outcome: {
              allowed: false,
              decision: outcome.decision,
              errorCode: "hook_blocked",
              errorMessage: `Blocked by permissionRequest hook: ${denial}`,
            },
            decision: "hook_denied",
          };
        }
        return {
          outcome,
          decision: answeredBy === "hook_allowed" && outcome.allowed ? "hook_allowed" : outcome.decision,
        };
      };

      /** Everything after the absolute refusals: preToolUse, the prompt, the run, postToolUse. */
      const gateAndRun = async (spec: ToolSpec, parsedArgs: unknown, initial: ClassifiedCall): Promise<ToolResult> => {
        let cls = initial;
        permission = cls.permission;
        // preToolUse decides before anyone is prompted: a deny refuses without
        // asking, an allow answers the prompt, an ask forces one.
        const pre = await runHooks("preToolUse", ctx.hooks?.preToolUse, hookPayload(parsedArgs, cls), hookOpts);
        if (ctx.signal?.aborted) return cancelled();
        report("preToolUse", pre);
        const blockedBy = pre.find((o) => !o.ok);
        if (blockedBy) {
          decision = "hook_denied";
          return fail(
            "hook_blocked",
            `Blocked by preToolUse hook${blockedBy.timedOut ? " (timed out)" : ""}: ` +
              (blockedBy.outputTail || `exit ${blockedBy.exitCode}`),
          );
        }

        let runArgs = parsedArgs;
        const updated = pre.find((o) => o.updatedInput !== undefined)?.updatedInput;
        if (updated !== undefined) {
          // Re-validate first; an invalid rewrite must not silently execute the
          // original call.
          const reparsed = spec.schema.safeParse(updated);
          if (!reparsed.success) {
            return fail(
              "invalid_hook_args",
              `preToolUse hook returned invalid arguments for ${call.name}`,
              reparsed.error.issues,
            );
          }
          runArgs = reparsed.data;
          effectiveArgs = reparsed.data;
          inputRewritten = true;
          // The rewrite can change the path/command, so re-classify, re-apply
          // the refusals and re-prepare: a hook must not smuggle a denylisted
          // call past the gate, and the state handed to run() must describe
          // the arguments actually being run.
          let re: Awaited<ReturnType<typeof classifyAndPrepare>>;
          try {
            re = await classifyAndPrepare(spec, runArgs);
          } catch (err) {
            return toolError(err);
          }
          cls = re.classified;
          classified = cls;
          permission = cls.permission;
          if (re.refused) {
            decision = re.refused.decision;
            return fail(re.refused.errorCode, re.refused.errorMessage);
          }
        }

        const hookAsk = pre.some((o) => o.decision === "ask");
        const hookAllow = !hookAsk && pre.some((o) => o.decision === "allow");
        const gate = await enforceWithHooks(cls, runArgs, hookAllow, hookAsk);
        decision = gate.decision;
        if (ctx.signal?.aborted) return cancelled();
        if (!gate.outcome.allowed) return fail(gate.outcome.errorCode, gate.outcome.errorMessage);

        // selectedHunks and prepared are call-local. A dispatcher can be used
        // concurrently by SDK consumers, so mutating the shared context lets
        // one approval alter another in-flight call.
        const runCtx: ToolContext = { ...ctx };
        delete runCtx.selectedHunks;
        delete runCtx.prepared;
        if (gate.outcome.selectedHunks !== undefined) runCtx.selectedHunks = [...gate.outcome.selectedHunks];
        if (preparedState !== undefined) runCtx.prepared = preparedState;

        let ran: ToolResult;
        try {
          const out = await spec.run(runArgs as never, runCtx);
          ran = {
            ok: true,
            data: out.data,
            ...(out.meta ? { meta: out.meta } : {}),
            ...(out.images && out.images.length > 0 ? { images: out.images } : {}),
          };
        } catch (err) {
          ran = toolError(err);
        }

        // postToolUse (every run) and postToolUseFailure (failed runs) see the
        // args actually run and a redacted, bounded copy of the result. They
        // never block; what they return reaches the model beside the result.
        const post = ctx.hooks?.postToolUse ?? [];
        const postFailure = ran.ok ? [] : (ctx.hooks?.postToolUseFailure ?? []);
        if (post.length > 0 || postFailure.length > 0) {
          const postPayload: HookPayload = { ...hookPayload(runArgs, cls), result: hookToolResult(ran) };
          report("postToolUse", await runHooks("postToolUse", post, postPayload, hookOpts));
          if (postFailure.length > 0 && !ctx.signal?.aborted) {
            report("postToolUseFailure", await runHooks("postToolUseFailure", postFailure, postPayload, hookOpts));
          }
        }
        return ctx.signal?.aborted ? cancelled() : ran;
      };

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
      } else if (!parsed?.success) {
        result = fail("invalid_args", `Invalid arguments for ${call.name}`, parsed?.error.issues);
      } else if (prepareFailure || !classified) {
        result = prepareFailure ?? fail("internal_error", `${call.name} produced no classification`);
      } else if (refusedBeforePrepare) {
        permission = classified.permission;
        decision = refusedBeforePrepare.decision;
        result = fail(refusedBeforePrepare.errorCode, refusedBeforePrepare.errorMessage);
      } else {
        result = await gateAndRun(tool, parsed.data, classified);
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
