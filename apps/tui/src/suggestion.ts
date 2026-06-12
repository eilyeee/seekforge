/**
 * Composer ghost suggestion (fish-shell style autosuggest, cf. DeepSeek-TUI
 * prompt_suggestion ghost text). Purely local: the newest history entry that
 * strictly extends the current input supplies the dimmed remainder, which →
 * accepts. No API calls, no async.
 */

const MIN_INPUT_CHARS = 3;

/**
 * Returns the REMAINDER (suffix after `input`) of the newest history entry
 * strictly starting with `input`, or null when:
 * - input is shorter than 3 chars (too noisy to suggest on),
 * - input contains a newline (multiline drafts don't ghost well),
 * - the only matches are identical to the input (nothing to add).
 */
export function ghostSuggestion(input: string, history: readonly string[]): string | null {
  if (input.length < MIN_INPUT_CHARS) return null;
  if (input.includes("\n")) return null;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i] as string;
    if (entry === input) continue; // never suggest the input itself
    if (entry.startsWith(input)) return entry.slice(input.length);
  }
  return null;
}
