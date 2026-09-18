/**
 * `exit_plan_mode`: how a plan run asks to start implementing.
 *
 * The loop owns this tool rather than the dispatcher, for the same reason it
 * owns agent_result: its effect is on the run itself (the permission mode, the
 * provider, the system prompt), which no ordinary tool can reach. The approval
 * goes through the run's normal confirm channel, so every host that can render
 * a permission request can render this one — and a host that auto-denies
 * (headless `-p`, schedules, the eval harness) leaves the run in plan mode.
 */
import type { ConfirmResult, PermissionRequest, ToolDefinitionForModel, ToolResult } from "@seekforge/shared";
import { denialFeedbackNote } from "../tools/permissions.js";

export const EXIT_PLAN_MODE_TOOL = "exit_plan_mode";

/** A plan is a document the user reads before approving; bound it like one. */
const MAX_PLAN_CHARS = 20_000;

export function buildExitPlanModeToolDefinition(): ToolDefinitionForModel {
  return {
    name: EXIT_PLAN_MODE_TOOL,
    description:
      "Submit your finished implementation plan for the user's approval. Call it once the plan is complete " +
      "(markdown: steps naming the files to change, verification commands, risks). If the user approves, this " +
      "same run switches to edit mode and you implement the plan right away. If they decline, you stay in " +
      "read-only plan mode: revise the plan using their feedback and submit again, or — when there is no " +
      "feedback — end your turn with the plan as your final answer. Never call it before the plan is done.",
    parameters: {
      type: "object",
      properties: {
        plan: {
          type: "string",
          description: "The complete plan, in markdown, exactly as the user should review it.",
        },
      },
      required: ["plan"],
      additionalProperties: false,
    },
  };
}

export function parseExitPlanModeArgs(args: unknown): { plan: string } | { error: ToolResult } {
  const plan = typeof args === "object" && args !== null ? (args as { plan?: unknown }).plan : undefined;
  if (typeof plan !== "string" || plan.trim() === "") {
    return { error: { ok: false, error: { code: "invalid_args", message: "exit_plan_mode needs a non-empty plan" } } };
  }
  if (plan.length > MAX_PLAN_CHARS) {
    return {
      error: {
        ok: false,
        error: {
          code: "invalid_args",
          message: `the plan is ${plan.length} characters; keep it under ${MAX_PLAN_CHARS}`,
        },
      },
    };
  }
  return { plan };
}

/**
 * The approval request. The plan travels raw — in `preview`, which every
 * frontend renders as a reviewable block, and in `description`, which a host
 * without preview support prints — never as a paraphrase. A session or
 * durable grant would mean nothing here, so none is offered.
 */
export function buildExitPlanModeRequest(plan: string): PermissionRequest {
  return {
    toolName: EXIT_PLAN_MODE_TOOL,
    permission: "write",
    approvalReason: "plan",
    description: `Leave plan mode and implement this plan (the run continues with edit permissions):\n\n${plan}`,
    preview: { path: "plan", diff: plan },
    sessionGrantable: false,
  };
}

export type ExitPlanModeDecision = { approved: true } | { approved: false; feedback: string };

export function readExitPlanModeAnswer(answer: ConfirmResult): ExitPlanModeDecision {
  if (typeof answer === "boolean") return answer ? { approved: true } : { approved: false, feedback: "" };
  if (answer.allow) return { approved: true };
  return { approved: false, feedback: denialFeedbackNote("feedback" in answer ? answer.feedback : undefined) };
}

export function approvedResult(): ToolResult {
  return {
    ok: true,
    data: {
      approved: true,
      mode: "edit",
      note:
        "The user approved the plan. Plan mode is over: write and command tools are now available under the " +
        "user's approval settings. Implement the plan step by step, verify the change, then report.",
    },
  };
}

/**
 * A refusal with feedback keeps the tool available so the model can revise;
 * a bare refusal (or a host that cannot ask) retires it for the run, so the
 * model ends with its plan instead of asking again.
 */
export function declinedResult(feedback: string): ToolResult {
  return {
    ok: false,
    error: {
      code: "denied_by_user",
      message:
        feedback !== ""
          ? `The user did not approve the plan and said: ${feedback}. You are still in read-only plan mode; ` +
            "revise the plan and call exit_plan_mode again."
          : "The plan was not approved. You are still in read-only plan mode and exit_plan_mode is no longer " +
            "available in this run; end your turn with the plan as your final answer.",
    },
  };
}
