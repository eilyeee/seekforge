import type { PlanItem } from "../tools/builtins/plan.js";

/**
 * Finalize gate: when the model stops calling tools (declares it is done), the
 * loop consults this before accepting the answer. It surfaces, as a single
 * one-time transient nudge, the highest-priority thing still left undone, so
 * the model gets one more turn to address it:
 *
 *   plan   (#6) — published a plan whose steps are not all done.
 *   verify (#1) — edited files but never ran the configured verify command.
 *   lint   (#1b) — edited files but never ran the configured lint command.
 *   review (#5) — edited files and a final self-review pass is enabled.
 *
 * Each kind fires AT MOST ONCE per run (`fired`), so the gate adds at most a
 * few extra turns and the run always terminates: if the model finishes again
 * without addressing a nudge, that kind is already spent and the next unmet
 * check (or a clean finish) follows. Priority order is finish-the-work →
 * prove-it-works → review-quality.
 *
 * Pure: no I/O. The loop owns the state (plan items captured from update_plan
 * results, change counts, whether verify ran since the last edit) and the
 * transient-message plumbing.
 */
export type FinalizeKind = "progress" | "plan" | "verify" | "lint" | "review";

export type FinalizeState = {
  /** Run mode — the progress guard only applies to edit-mode runs. */
  mode: "ask" | "edit";
  /** Cumulative tool calls this run (to detect a no-investigation bail-out). */
  toolCalls: number;
  /** Latest plan published via update_plan this run, if any. */
  planItems?: PlanItem[];
  /** Number of files changed this run (apply_patch/write_file successes). */
  changedFiles: number;
  /** Configured verify command (deps.verifyCommand), if any. */
  verifyCommand?: string;
  /** Whether the verify command has run since the most recent edit. */
  verifyRanSinceEdit: boolean;
  /** Configured lint command (deps.lintCommand), if any. */
  lintCommand?: string;
  /** Whether the lint command has run since the most recent edit. */
  lintRanSinceEdit: boolean;
  /** Whether a final self-review pass is enabled (deps.finalizeReview). */
  reviewEnabled: boolean;
  /** Whether the premature-finish guard is enabled (deps.guardNoProgress). */
  guardNoProgress: boolean;
  /** Kinds already nudged this run (each fires once). */
  fired: ReadonlySet<FinalizeKind>;
};

/**
 * Below this many tool calls, an edit-mode run that changed nothing is treated
 * as a premature "bail-out" finish (declared done without really investigating
 * — the failure mode observed on some models) rather than a considered no-op.
 */
const MIN_PROGRESS_TOOL_CALLS = 2;

export type FinalizeNudge = {
  kind: FinalizeKind;
  /** Short, user-facing reason the run is continuing (a `notice` event). */
  notice: string;
  /** Transient user message injected into the conversation for the model. */
  message: string;
};

/** The highest-priority unmet finalize check, or null when the run may finish. */
export function nextFinalizeNudge(s: FinalizeState): FinalizeNudge | null {
  // 0. Premature finish: an edit-mode run that declares done having changed
  // nothing AND barely used any tools never really engaged. Push back once.
  // (A run that investigated — many reads/searches — and concluded no change is
  // needed is NOT caught: it has the tool calls to show for it.)
  if (
    s.guardNoProgress &&
    !s.fired.has("progress") &&
    s.mode === "edit" &&
    s.changedFiles === 0 &&
    s.toolCalls < MIN_PROGRESS_TOOL_CALLS
  ) {
    return {
      kind: "progress",
      notice: "Finishing with no investigation or changes — asking the agent to actually work the task.",
      message:
        "[harness] You are finishing without having investigated the codebase or changed anything. " +
        "Actually work the task: orient (repo_map), find the relevant code (search_text/read_file), make " +
        "the needed edits, and verify. If the task genuinely requires no change, say so explicitly and " +
        "explain why — do not just stop.",
    };
  }

  // 1. Finish the work: don't accept "done" while published plan steps are open.
  if (!s.fired.has("plan") && s.planItems && s.planItems.length > 0) {
    const open = s.planItems.filter((i) => i.status !== "done");
    if (open.length > 0) {
      const list = open.map((i) => `- ${i.step} (${i.status})`).join("\n");
      return {
        kind: "plan",
        notice: `Plan still has ${open.length} incomplete step(s) — continuing.`,
        message:
          `[harness] You published a plan but ${open.length} step(s) are not done:\n${list}\n` +
          "Complete the remaining work, or call update_plan to mark steps done / drop ones " +
          "you have deliberately skipped (say briefly why), then finish.",
      };
    }
  }

  // 2. Prove it works: edits were made but the verify command has not run since.
  const verifyCommand = s.verifyCommand?.trim();
  if (
    !s.fired.has("verify") &&
    s.changedFiles > 0 &&
    verifyCommand !== undefined &&
    verifyCommand !== "" &&
    !s.verifyRanSinceEdit
  ) {
    return {
      kind: "verify",
      notice: "Changes not yet verified — asking the agent to run the verify command.",
      message:
        `[harness] You changed ${s.changedFiles} file(s) but have not run the verification ` +
        `command since the last edit. Run \`${verifyCommand}\` with run_command, fix anything it ` +
        "reports, then finish. If it genuinely cannot run here, say so explicitly rather than skipping it.",
    };
  }

  // 2b. Prove it lints: edits were made but the lint command has not run since.
  // Parallel to verify — same "only re-run after a NEW edit" gating.
  const lintCommand = s.lintCommand?.trim();
  if (
    !s.fired.has("lint") &&
    s.changedFiles > 0 &&
    lintCommand !== undefined &&
    lintCommand !== "" &&
    !s.lintRanSinceEdit
  ) {
    return {
      kind: "lint",
      notice: "Changes not yet linted — asking the agent to run the lint command.",
      message:
        `[harness] You changed ${s.changedFiles} file(s) but have not run the lint ` +
        `command since the last edit. Run \`${lintCommand}\` with run_command, fix anything it ` +
        "reports, then finish. If it genuinely cannot run here, say so explicitly rather than skipping it.",
    };
  }

  // 3. Review quality: one self-review pass over the diff before finishing.
  if (!s.fired.has("review") && s.reviewEnabled && s.changedFiles > 0) {
    return {
      kind: "review",
      notice: "Doing a final self-review of the changes.",
      message:
        "[harness] Before finishing, review your own diff: inspect the changes (e.g. with git_diff), " +
        "check for leftover debug code, unhandled edge cases, and that the FULL task is addressed. " +
        "Fix anything you find, then finish.",
    };
  }

  return null;
}
