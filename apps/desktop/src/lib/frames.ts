/** Pure builders for the start/send client frames (plan & approval controls). */
import type { ClientFrame, RunOverrides } from "./ws-types";
import type { StartMode } from "./tabs";

export type { RunOverrides };

/** The canned follow-up task that turns a completed plan into execution. */
export const EXECUTE_PLAN_TASK =
  "Execute the plan you produced above, step by step. Make the changes and run the verification.";

/** Adds an optional workspace id to a frame (omitted when empty for back-compat). */
function withWs<T extends ClientFrame>(frame: T, ws?: string): T {
  return ws ? { ...frame, ws } : frame;
}

/** Chat-header control state a tab carries (see ChatTab in tabs.ts). */
export type HeaderControls = {
  /** Model override; empty = server config default (field omitted). */
  model: string;
  /** null = untouched (config default, field omitted); a boolean once toggled. */
  thinking: boolean | null;
  /** Only sent while thinking is explicitly on. */
  reasoningEffort: "high" | "max";
};

/**
 * Frame override fields from the chat-header controls. Untouched controls
 * produce NO fields (the server config keeps deciding); reasoningEffort is
 * only meaningful — and only sent — when thinking is explicitly on.
 */
export function overridesOf(controls: HeaderControls): RunOverrides {
  const model = controls.model.trim();
  return {
    ...(model !== "" ? { model } : {}),
    ...(controls.thinking !== null ? { thinking: controls.thinking } : {}),
    ...(controls.thinking === true ? { reasoningEffort: controls.reasoningEffort } : {}),
  };
}

/**
 * "plan" maps to a read-only ask run with the plan flag set; the server
 * builds the planning prompt from it (see SERVER-API.md). `ws` targets the
 * workspace the run executes in (default: first workspace when omitted).
 */
export function buildStartFrame(
  task: string,
  mode: StartMode,
  autoApprove: boolean,
  ws?: string,
  overrides: RunOverrides = {},
): ClientFrame {
  const approvalMode = autoApprove ? "auto" : "confirm";
  if (mode === "plan") {
    return withWs({ type: "start", task, mode: "ask", approvalMode, plan: true, ...overrides }, ws);
  }
  return withWs({ type: "start", task, mode, approvalMode, ...overrides }, ws);
}

/** Continue a session; per-message overrides apply exactly like on start. */
export function buildSendFrame(
  sessionId: string,
  task: string,
  ws?: string,
  overrides: RunOverrides = {},
): ClientFrame {
  return withWs({ type: "send", sessionId, task, ...overrides }, ws);
}

/** Continue the plan session with an edit-mode override, in the tab's workspace. */
export function buildExecutePlanFrame(sessionId: string, ws?: string, overrides: RunOverrides = {}): ClientFrame {
  return withWs({ type: "send", sessionId, task: EXECUTE_PLAN_TASK, mode: "edit", ...overrides }, ws);
}
