/**
 * Prompt / config A/B variants.
 *
 * A variant is a named, pure transform of the agent build options the harness
 * hands to the factory. It can flip a core dep knob (e.g. compaction strategy)
 * and/or inject a suffix into the task text (the only seam the harness has to
 * influence the system prompt without forking core's buildSystemPrompt, which
 * would also drop skill selection — see loop.ts:268).
 *
 * apply() MUST be pure: it returns a new options object and never mutates the
 * input (so the same base can be reused across variants in one A/B run).
 */

/**
 * The knobs a variant may transform. A subset of core's AgentCoreDeps that the
 * factory understands, plus harness-only task shaping. All optional; absent
 * fields fall back to the factory defaults.
 */
export type AgentBuildOptions = {
  /** Full-compaction strategy. Maps to AgentCoreDeps.compaction. */
  compaction?: "mechanical" | "llm";
  /** Model context window in tokens. Maps to AgentCoreDeps.contextWindowTokens. */
  contextWindowTokens?: number;
  /**
   * Appended to the task text the agent receives. Use this for prompt-style
   * variants (e.g. a brevity instruction): it rides into the conversation as
   * part of the user turn, so skill selection and the system prompt are
   * unaffected.
   */
  taskSuffix?: string;
  /** Failure escalation (AgentCoreDeps); needs planModel. See docs/configuration.md. */
  escalateOnFailure?: boolean;
  /** Stronger model for plan/escalation; required for escalateOnFailure. */
  planModel?: string;
  /**
   * Override the main agent model (else the configured config.model). Lets an
   * A/B run the same task set under a weaker vs stronger model — useful because
   * the round-52 transparent levers are expected to help a weaker model more.
   */
  model?: string;
  /** Inject project-memory brief (default true). The no-memory variant sets false. */
  injectMemory?: boolean;
  /** Self-verification command (AgentCoreDeps.verifyCommand). The verify-gate variant sets it. */
  verifyCommand?: string;
  /**
   * Run the verify command automatically on the finish turn (AgentCoreDeps.autoVerify,
   * default true when verifyCommand is set). The no-auto-verify variant sets false to
   * measure auto-run-and-feed-back vs the nudge-only path.
   */
  autoVerify?: boolean;
  /** Self-lint command (AgentCoreDeps.lintCommand). The lint-gate variant sets it. */
  lintCommand?: string;
  /** Run the lint command automatically on the finish turn (AgentCoreDeps.autoLint, default true). */
  autoLint?: boolean;
  /** Model-adaptive edit format (AgentCoreDeps.editFormat): "patch" (default) | "whole". */
  editFormat?: "patch" | "whole";
  /** Inject the task-relevant file shortlist (AgentCoreDeps.injectRelevantFiles, default true). */
  injectRelevantFiles?: boolean;
  /** One-time self-review nudge after edits (AgentCoreDeps.finalizeReview). */
  finalizeReview?: boolean;
  /** Premature-finish guard (AgentCoreDeps.guardNoProgress). */
  guardNoProgress?: boolean;
  /** Skill selection/injection (default true). */
  injectSkills?: boolean;
};

export type Variant = {
  name: string;
  describe: string;
  /** Pure: returns a new options object derived from `base`. */
  apply: (base: AgentBuildOptions) => AgentBuildOptions;
};

const TERSE_INSTRUCTION =
  "\n\n[variant:terse] Be maximally concise: minimize prose in the final report " +
  "and avoid any narration. Take the most direct path to a verified result.";

/**
 * The variant registry. `control` is the identity transform and is always the
 * baseline. To add a variant: append an entry whose apply() derives a new
 * AgentBuildOptions from `base` (never mutate `base`).
 */
export const VARIANTS: Variant[] = [
  {
    name: "control",
    describe: "Baseline: no changes to the agent configuration.",
    apply: (base) => ({ ...base }),
  },
  {
    name: "terse-prompt",
    describe: "Appends a brevity/no-narration instruction to the task text.",
    apply: (base) => ({
      ...base,
      taskSuffix: `${base.taskSuffix ?? ""}${TERSE_INSTRUCTION}`,
    }),
  },
  {
    name: "llm-compaction",
    describe: "Uses LLM summarization for full context compaction (vs mechanical).",
    apply: (base) => ({ ...base, compaction: "llm" }),
  },
  {
    name: "no-memory",
    describe: "Disables project-memory injection — pair with a memory-seeded task to measure memory's value.",
    apply: (base) => ({ ...base, injectMemory: false }),
  },
  {
    name: "no-skills",
    describe: "Disables skill selection and prompt injection to measure the net value of the skills system.",
    apply: (base) => ({ ...base, injectSkills: false }),
  },
  {
    name: "verify-gate",
    describe:
      "Enables the self-verification finalize gate (verifyCommand=npm test): after edits the agent " +
      "is nudged once to run the suite and fix failures before finishing. A/B vs control to measure it.",
    apply: (base) => ({ ...base, verifyCommand: "npm test" }),
  },
  {
    name: "lint-gate",
    describe:
      "Enables the self-lint finalize gate (lintCommand=npm run lint): after edits the agent runs " +
      "the linter (auto-run by default) and fixes issues before finishing. A/B vs control to measure it.",
    apply: (base) => ({ ...base, lintCommand: "npm run lint" }),
  },
  {
    name: "whole-file-edits",
    describe:
      "Guides the agent to prefer write_file (whole-file rewrites) over apply_patch (editFormat=whole) " +
      "— for weak/local models that mangle search/replace. A/B vs control on a weaker model.",
    apply: (base) => ({ ...base, editFormat: "whole" }),
  },
  {
    name: "no-progress-guard",
    describe:
      "Enables the premature-finish guard: an edit run that declares done having changed nothing and " +
      "barely used any tools is nudged once to actually work the task. A/B vs control to measure it.",
    apply: (base) => ({ ...base, guardNoProgress: true }),
  },
  {
    name: "no-retrieval",
    describe:
      "Disables the auto-injected task-relevant file shortlist — pair with a fixture that clears the " +
      "40-code-file retrieval floor (cjk-buried-discount, cjk-buried-retry) to measure whether the " +
      "shortlist actually helps; smaller fixtures never trigger retrieval so the A/B would be a no-op.",
    apply: (base) => ({ ...base, injectRelevantFiles: false }),
  },
  {
    name: "review-gate",
    describe:
      "Enables the final-review gate (finalizeReview): after edits the agent gets one self-review " +
      "pass over its diff (or a reviewer subagent if wired in). A/B vs control to measure it.",
    apply: (base) => ({ ...base, finalizeReview: true }),
  },
  {
    name: "no-auto-verify",
    describe:
      "Verify gate WITHOUT auto-run (verifyCommand=npm test, autoVerify=false): degrades to the " +
      "one-time nudge. A/B vs verify-gate to isolate the value of auto-running the command.",
    apply: (base) => ({ ...base, verifyCommand: "npm test", autoVerify: false }),
  },
  {
    name: "model-pro",
    describe:
      "Runs the suite under the stronger deepseek-v4-pro model instead of the configured default. " +
      "A/B vs control to see how much the model tier alone moves results (and re-run a capability " +
      "A/B under it to check whether a transparent lever helps the weaker model more).",
    apply: (base) => ({ ...base, model: "deepseek-v4-pro" }),
  },
  {
    name: "context-tight",
    describe:
      "Shrinks the model context window to 32000 tokens (no other variant exercises this knob), " +
      "forcing full compaction to trigger earlier and more often. A/B vs control.",
    // Hypothesis: a tighter context window makes the agent compact sooner, so it
    // carries fewer stale tokens per turn. Does that net-save tokens/cost without
    // hurting completion (compaction can drop context the agent still needed)?
    // Read cost-per-success + Win/Loss/Tie: a real win is lower cost at equal or
    // better completion; a loss is more Losses (dropped context breaks tasks).
    apply: (base) => ({ ...base, contextWindowTokens: 32000 }),
  },
  {
    name: "verify-and-review",
    describe:
      "Stacks both quality gates: self-verify (verifyCommand=npm test, autoVerify=true) PLUS a final " +
      "diff self-review (finalizeReview=true). A/B vs control to price the combined gate.",
    // Hypothesis: auto-running the test suite AND doing a one-time self-review of
    // the diff before finishing raises the completion rate versus control. This
    // is the capability question — measure the token/turn cost the combined gate
    // adds. Decide with cost-per-success: keep it only if the completion gain
    // outweighs the extra cost (verify-gate and review-gate alone each measured
    // as cost with little/no benefit — does stacking them clear that bar?).
    apply: (base) => ({
      ...base,
      verifyCommand: "npm test",
      autoVerify: true,
      finalizeReview: true,
    }),
  },
];

const BY_NAME = new Map(VARIANTS.map((v) => [v.name, v]));

export function getVariant(name: string): Variant {
  const variant = BY_NAME.get(name);
  if (!variant) {
    throw new Error(`unknown variant "${name}"; known: ${VARIANTS.map((v) => v.name).join(", ")}`);
  }
  return variant;
}

export function listVariants(): Variant[] {
  return VARIANTS;
}
