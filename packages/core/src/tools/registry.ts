import type { z } from "zod";
import type {
  PermissionName,
  ToolCall,
  ToolDefinitionForModel,
  ToolResult,
} from "@seekforge/shared";
import type { ToolContext, ToolDispatcher } from "./index.js";
import { ToolError } from "./errors.js";
import { zodToJsonSchema } from "./json-schema.js";
import { enforcePermission, type PermissionDecision } from "./permissions.js";

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
          classified = tool.classify(parsed.data as never, ctx);
          permission = classified.permission;
          const outcome = await enforcePermission(call.name, classified, ctx);
          decision = outcome.decision;
          if (!outcome.allowed) {
            result = fail(outcome.errorCode, outcome.errorMessage);
          } else {
            try {
              const out = await tool.run(parsed.data as never, ctx);
              result = { ok: true, data: out.data, ...(out.meta ? { meta: out.meta } : {}) };
            } catch (err) {
              if (err instanceof ToolError) {
                result = fail(err.code, err.message, err.detail);
              } else {
                result = fail("internal_error", err instanceof Error ? err.message : String(err));
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
        args: call.arguments,
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
