/** Pure builders for the start/send client frames (plan & approval controls). */
import type { ClientFrame } from "./ws-types";
import type { StartMode } from "./tabs";

/** The canned follow-up task that turns a completed plan into execution. */
export const EXECUTE_PLAN_TASK =
  "Execute the plan you produced above, step by step. Make the changes and run the verification.";

/** Adds an optional workspace id to a frame (omitted when empty for back-compat). */
function withWs<T extends ClientFrame>(frame: T, ws?: string): T {
  return ws ? { ...frame, ws } : frame;
}

/**
 * "plan" maps to a read-only ask run with the plan flag set; the server
 * builds the planning prompt from it (see SERVER-API.md). `ws` targets the
 * workspace the run executes in (default: first workspace when omitted).
 */
export function buildStartFrame(task: string, mode: StartMode, autoApprove: boolean, ws?: string): ClientFrame {
  const approvalMode = autoApprove ? "auto" : "confirm";
  if (mode === "plan") return withWs({ type: "start", task, mode: "ask", approvalMode, plan: true }, ws);
  return withWs({ type: "start", task, mode, approvalMode }, ws);
}

/** Continue the plan session with an edit-mode override, in the tab's workspace. */
export function buildExecutePlanFrame(sessionId: string, ws?: string): ClientFrame {
  return withWs({ type: "send", sessionId, task: EXECUTE_PLAN_TASK, mode: "edit" }, ws);
}
