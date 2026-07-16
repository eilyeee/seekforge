/**
 * Accent theme resolution and named presets. The TUI uses a single accent
 * color (plus an optional dim tone); precedence is SEEKFORGE_TUI_ACCENT env
 * var > config value > "cyan". The value may be a preset name from
 * THEME_PRESETS or a raw ink color name. Invalid values fall back to cyan.
 * NO_COLOR is honored by Ink/chalk automatically — nothing to do here.
 */

export type Theme = { accent: string; dim?: string };

/** A named accent preset: the accent ink color plus an optional dim tone. */
export type ThemePreset = { accent: string; dim?: string; description: string };

/** Valid ink color names an accent may take. */
export const INK_COLORS: readonly string[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "gray",
  "grey",
  "blackBright",
  "redBright",
  "greenBright",
  "yellowBright",
  "blueBright",
  "magentaBright",
  "cyanBright",
  "whiteBright",
];

/**
 * Named theme presets selectable via /theme, config, or SEEKFORGE_TUI_ACCENT.
 *
 * `deepseek` references CodeWhale's palette (DeepSeek-TUI
 * crates/tui/src/deepseek_theme.rs + palette.rs): its chrome sits on
 * DEEPSEEK_INK deep navy #0A1120 and carries the blue identity through
 * WHALE_INFO sky #6AAEF2 / WHALE_MODE_AGENT #5096FF / WHALE_BORDER #345891.
 * (Note: the palette's DEEPSEEK_BLUE alias points at Signal Gold #F6C453 —
 * an accent chip color, not the brand blue.) The closest 16-color ink name
 * to that sky/agent blue is "blueBright".
 */
export const THEME_PRESETS: Record<string, ThemePreset> = {
  default: { accent: "cyan", description: "SeekForge default cyan" },
  deepseek: {
    accent: "blueBright",
    dim: "gray",
    description: "CodeWhale blue (sky #6AAEF2 on deep-navy ink)",
  },
  mono: { accent: "white", dim: "gray", description: "no-color white/gray" },
  solarized: {
    accent: "blue",
    dim: "gray",
    description: "Solarized blue (#268BD2)",
  },
  matrix: { accent: "green", dim: "green", description: "terminal green" },
};

const DEFAULT_ACCENT = "cyan";

/**
 * Resolve the theme. `value` comes from config; the env var wins over it.
 * Each candidate may be a preset name (looked up in THEME_PRESETS) or a raw
 * ink color name. Anything else is ignored, falling back to "cyan".
 */
export function loadTheme(value?: string): Theme {
  for (const candidate of [process.env.SEEKFORGE_TUI_ACCENT, value]) {
    if (!candidate) continue;
    const preset = THEME_PRESETS[candidate];
    if (preset) {
      return preset.dim ? { accent: preset.accent, dim: preset.dim } : { accent: preset.accent };
    }
    if (INK_COLORS.includes(candidate)) return { accent: candidate };
  }
  return { accent: DEFAULT_ACCENT };
}

/**
 * Lines for the /theme picker overlay: one row per preset, the current one
 * marked with "●" (others "○"). `current` may be a preset name or a raw ink
 * color (matched against each preset's accent).
 */
export function themePickerLines(current: string): string[] {
  return Object.entries(THEME_PRESETS).map(([name, preset]) => {
    const active = current === name || current === preset.accent;
    return `${active ? "●" : "○"} ${name.padEnd(10)} ${preset.accent} — ${preset.description}`;
  });
}
