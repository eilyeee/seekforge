/**
 * Theme resolution — pure logic for the dark/light/system switcher.
 *
 * `ThemeChoice` is what the user picks (and what we persist); `ResolvedTheme`
 * is the concrete palette to paint ("system" follows the OS). The applied
 * value is written to `<html data-theme="…">` (only for light — dark is the
 * default `:root`, so we omit the attribute to keep the markup clean).
 */

export type ThemeChoice = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "seekforge.theme";

const CHOICES: ThemeChoice[] = ["dark", "light", "system"];

export function isThemeChoice(v: unknown): v is ThemeChoice {
  return typeof v === "string" && (CHOICES as string[]).includes(v);
}

/** Reads a stored choice, defaulting to "system" when unset/garbage. */
export function readThemeChoice(stored: string | null): ThemeChoice {
  return isThemeChoice(stored) ? stored : "system";
}

/** Cycle order for a single toggle: dark -> light -> system -> dark. */
export function nextThemeChoice(current: ThemeChoice): ThemeChoice {
  const i = CHOICES.indexOf(current);
  return CHOICES[(i + 1) % CHOICES.length]!;
}

/** "system" resolves against the OS preference; the rest pass through. */
export function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): ResolvedTheme {
  if (choice === "system") return systemPrefersDark ? "dark" : "light";
  return choice;
}

/**
 * The `data-theme` attribute value for a resolved theme. Dark is the default
 * (`:root`), so it maps to null — meaning "remove the attribute".
 */
export function dataThemeAttr(resolved: ResolvedTheme): "light" | null {
  return resolved === "light" ? "light" : null;
}
