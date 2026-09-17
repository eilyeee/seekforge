/**
 * Reasoning effort, per wire dialect.
 *
 * SeekForge offers four levels (`REASONING_EFFORTS` in @seekforge/shared); no
 * endpoint has exactly those four, so each dialect says what a level becomes
 * there. The rule everywhere is the same: a level the endpoint has no word for
 * is clamped to the nearest one it does, and a model nobody has checked gets no
 * effort parameter at all — an unknown field is a 400 on a strict endpoint,
 * which is a worse answer than the model's own default.
 *
 * Sources, checked 2026-09-17:
 * - DeepSeek: https://api-docs.deepseek.com/api/create-chat-completion —
 *   top-level `reasoning_effort` in none/low/high/max; `medium` is accepted and
 *   run as `high`.
 * - Anthropic: https://platform.claude.com/docs/en/build-with-claude/effort —
 *   `output_config.effort` in low/medium/high/xhigh/max; Haiku and the
 *   pre-4.5 Opus/Sonnet ids take no effort; `max` needs Opus 4.6+ or Sonnet 4.6+;
 *   thinking cannot be disabled above `high`.
 * - OpenAI: https://developers.openai.com/api/docs/models — gpt-5.6-* take up
 *   to `max`, gpt-5.2 through gpt-5.5 up to `xhigh`, gpt-5 and gpt-5.1 up to
 *   `high`.
 * - OpenRouter: `reasoning.effort` in none/minimal/low/medium/high/xhigh,
 *   translated per upstream model by the router.
 */

import type { ReasoningEffort } from "@seekforge/shared";

/**
 * How an OpenAI-compatible endpoint that is not DeepSeek takes an effort level.
 * `openai`: top-level `reasoning_effort`, for the model families listed in
 * `openaiEffortCeiling`. `openrouter`: `reasoning: { effort }`, for any model.
 */
export type EffortDialect = "openai" | "openrouter";

/** DeepSeek's own spelling. It runs `medium` as `high`; saying so here keeps the request honest. */
export function deepseekEffort(effort: ReasoningEffort): "low" | "high" | "max" {
  return effort === "medium" ? "high" : effort;
}

/**
 * Claude ids that take no `output_config.effort`: Haiku, anything before the 4
 * line, and Opus/Sonnet 4.0, 4.1 and Sonnet 4.5 (dated or not). A newer id is
 * assumed to take it — every model since Opus 4.5 does.
 */
const ANTHROPIC_NO_EFFORT =
  /haiku|^claude-(?:instant|[123])(?:[-.]|$)|^claude-(?:opus|sonnet)-4(?:-[01])?(?:-\d{8})?$|^claude-sonnet-4-5(?:-\d{8})?$/;
/** Takes effort but not `max` (added with Opus 4.6). */
const ANTHROPIC_NO_MAX = /^claude-opus-4-5(?:-\d{8})?$/;

export function anthropicEffort(
  model: string,
  effort: ReasoningEffort,
  thinkingDisabled: boolean,
): "low" | "medium" | "high" | "max" | undefined {
  const id = model.toLowerCase();
  if (ANTHROPIC_NO_EFFORT.test(id)) return undefined;
  // Turning thinking off is only accepted at `high` or below.
  if (effort === "max" && (thinkingDisabled || ANTHROPIC_NO_MAX.test(id))) return "high";
  return effort;
}

/** The highest `reasoning_effort` an OpenAI model family takes; undefined = send none. */
function openaiEffortCeiling(model: string): "max" | "xhigh" | "high" | undefined {
  const id = model.toLowerCase();
  // `-pro` models accept a narrower, per-model set; none has been checked.
  if (/-pro(?:-|$)/.test(id)) return undefined;
  if (/^gpt-5\.6(?:-|$)/.test(id)) return "max";
  if (/^gpt-5\.[2-5](?:-|$)/.test(id)) return "xhigh";
  if (/^gpt-5(?:\.1)?(?:-|$)/.test(id)) return "high";
  return undefined;
}

/**
 * The effort field for an OpenAI-compatible, non-DeepSeek request, or undefined
 * when this model/dialect takes none.
 */
export function openAiCompatibleEffort(
  dialect: EffortDialect,
  model: string,
  effort: ReasoningEffort,
): Record<string, unknown> | undefined {
  if (dialect === "openrouter") {
    return { reasoning: { effort: effort === "max" ? "xhigh" : effort } };
  }
  const ceiling = openaiEffortCeiling(model);
  if (ceiling === undefined) return undefined;
  return { reasoning_effort: effort === "max" ? ceiling : effort };
}
