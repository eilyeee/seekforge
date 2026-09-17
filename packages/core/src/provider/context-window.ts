import { DEFAULT_CONTEXT_WINDOW_TOKENS, MODEL_CONTEXT_WINDOWS } from "./constants.js";

const PREFIX_SEPARATORS = new Set(["-", ".", ":", "@", "["]);

/**
 * The id the built-in table is keyed by: routers and clouds wrap the vendor id
 * (`anthropic/claude-opus-5`, `us.anthropic.claude-opus-5-v1:0`), and the
 * window belongs to the model, not to the route.
 */
function tableId(model: string): string {
  const lower = model.trim().toLowerCase();
  const unrouted = lower.slice(lower.lastIndexOf("/") + 1);
  return unrouted.replace(/^(?:[a-z0-9-]+\.)+(?=claude-)/, "");
}

function builtinWindow(id: string): number | undefined {
  let best: { key: string; tokens: number } | undefined;
  for (const [key, tokens] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    const matches =
      id === key ||
      (id.startsWith(key) &&
        (PREFIX_SEPARATORS.has(key.charAt(key.length - 1)) || PREFIX_SEPARATORS.has(id.charAt(key.length))));
    if (matches && (best === undefined || key.length > best.key.length)) best = { key, tokens };
  }
  return best?.tokens;
}

/**
 * The context window, in tokens, to budget a request to `model` against.
 *
 * A user override (`modelContextWindows`, keyed by the exact model id the
 * provider is configured with) wins, then the built-in table, then the
 * conservative default.
 */
export function resolveContextWindow(model: string, overrides?: Readonly<Record<string, number>>): number {
  const override = overrides && Object.hasOwn(overrides, model) ? overrides[model] : undefined;
  if (override !== undefined) return override;
  return builtinWindow(tableId(model)) ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
}

/**
 * Validates a `modelContextWindows` map before anything is built from it. An
 * entry that is not a positive safe integer would otherwise become a NaN or
 * zero budget, so the error names the entry.
 */
export function assertModelContextWindows(value: unknown): asserts value is Record<string, number> | undefined {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError("modelContextWindows must be an object mapping model ids to token counts");
  }
  for (const [model, tokens] of Object.entries(value)) {
    if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens <= 0) {
      throw new RangeError(`modelContextWindows["${model}"] must be a positive safe integer (tokens)`);
    }
  }
}

/** Validates an `autoCompactThreshold`: a fraction of the context budget. */
export function assertAutoCompactThreshold(value: unknown): asserts value is number | undefined {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new RangeError("autoCompactThreshold must be a finite number greater than 0 and at most 1");
  }
}
