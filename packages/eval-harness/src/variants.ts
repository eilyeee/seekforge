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
  /** Inject project-memory brief (default true). The no-memory variant sets false. */
  injectMemory?: boolean;
  /** Self-verification command (AgentCoreDeps.verifyCommand). The verify-gate variant sets it. */
  verifyCommand?: string;
  /** One-time self-review nudge after edits (AgentCoreDeps.finalizeReview). */
  finalizeReview?: boolean;
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
    name: "verify-gate",
    describe:
      "Enables the self-verification finalize gate (verifyCommand=npm test): after edits the agent " +
      "is nudged once to run the suite and fix failures before finishing. A/B vs control to measure it.",
    apply: (base) => ({ ...base, verifyCommand: "npm test" }),
  },
];

const BY_NAME = new Map(VARIANTS.map((v) => [v.name, v]));

export function getVariant(name: string): Variant {
  const variant = BY_NAME.get(name);
  if (!variant) {
    throw new Error(
      `unknown variant "${name}"; known: ${VARIANTS.map((v) => v.name).join(", ")}`,
    );
  }
  return variant;
}

export function listVariants(): Variant[] {
  return VARIANTS;
}
