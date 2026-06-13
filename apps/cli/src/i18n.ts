/**
 * Tiny i18n for the CLI's user-facing chrome — same pattern as the TUI's
 * strings.ts: no deps, a flat key → string table per locale with an English
 * fallback chain (t(key) → STRINGS[locale][key] → STRINGS.en[key] → key).
 *
 * The locale is resolved ONCE at startup (config.locale > SEEKFORGE_LANG >
 * LC_ALL/LANG > en); a CLI invocation is one-shot, so no live switching.
 * `--help` / option text is intentionally NOT translated (kept English).
 * `{name}` placeholders interpolate from the optional vars argument.
 */
import { common } from "./i18n/common.js";
import { repl } from "./i18n/repl.js";
import { commands } from "./i18n/commands.js";

export type Locale = "en" | "zh-CN";

type Table = { en: Record<string, string>; zh: Record<string, string> };
const TABLES: Table[] = [common, repl, commands];
const EN: Record<string, string> = Object.assign({}, ...TABLES.map((t) => t.en));
const ZH: Record<string, string> = Object.assign({}, ...TABLES.map((t) => t.zh));
const STRINGS: Record<Locale, Record<string, string>> = { en: EN, "zh-CN": ZH };

let current: Locale = "en";

/** SEEKFORGE_LANG (explicit) > LC_ALL > LANG; any "zh*" value → zh-CN, else en. */
export function detectLocale(env: Record<string, string | undefined> = process.env): Locale {
  const explicit = env.SEEKFORGE_LANG;
  if (explicit) return explicit.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  for (const value of [env.LC_ALL, env.LANG]) {
    if (value && value.toLowerCase().startsWith("zh")) return "zh-CN";
  }
  return "en";
}

export function setLocale(locale: Locale): void {
  current = locale;
}

export function getLocale(): Locale {
  return current;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  let s = STRINGS[current][key] ?? STRINGS.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
