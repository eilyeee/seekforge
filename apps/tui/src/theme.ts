/**
 * Accent theme resolution. The TUI uses a single accent color; precedence is
 * SEEKFORGE_TUI_ACCENT env var > config value > "cyan". Invalid names fall
 * back. NO_COLOR is honored by Ink/chalk automatically — nothing to do here.
 */

export type Theme = { accent: string };

/** Valid ink color names an accent may take. */
export const INK_COLORS: readonly string[] = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "gray", "grey",
  "blackBright", "redBright", "greenBright", "yellowBright", "blueBright",
  "magentaBright", "cyanBright", "whiteBright",
];

const DEFAULT_ACCENT = "cyan";

/**
 * Resolve the theme. `accent` comes from config; the env var wins over it.
 * Anything not in INK_COLORS is ignored, falling back to "cyan".
 */
export function loadTheme(accent?: string): Theme {
  for (const candidate of [process.env.SEEKFORGE_TUI_ACCENT, accent]) {
    if (candidate && INK_COLORS.includes(candidate)) return { accent: candidate };
  }
  return { accent: DEFAULT_ACCENT };
}
