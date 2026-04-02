/** Pure builders for the start/send client frames (plan & approval controls). */
import type { ClientFrame } from "./ws-types";
import type { StartMode } from "./tabs";

/** The canned follow-up task that turns a completed plan into execution. */
export const EXECUTE_PLAN_TASK =
  "Execute the plan you produced above, step by step. Make the changes and run the verification.";

/**
 * "plan" maps to a read-only ask run with the plan flag set; the server
 * builds the planning prompt from it (see SERVER-API.md).
 */
export function buildStartFrame(task: string, mode: StartMode, autoApprove: boolean): ClientFrame {
  const approvalMode = autoApprove ? "auto" : "confirm";
  if (mode === "plan") return { type: "start", task, mode: "ask", approvalMode, plan: true };
  return { type: "start", task, mode, approvalMode };
}

/** Continue the plan session with an edit-mode override. */
export function buildExecutePlanFrame(sessionId: string): ClientFrame {
  return { type: "send", sessionId, task: EXECUTE_PLAN_TASK, mode: "edit" };
}
