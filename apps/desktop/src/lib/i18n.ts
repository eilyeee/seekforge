/**
 * Tiny i18n for the desktop UI — same spirit as the TUI's strings.ts: no deps,
 * no ICU, a flat key → string table per locale with an English fallback chain:
 *
 *   t(key) → STRINGS[locale][key] → STRINGS.en[key] → key
 *
 * A missing key never throws; it renders as the key so a typo is visible.
 * `{name}` placeholders are interpolated from the optional vars argument.
 *
 * Locale lives in a tiny external store so React re-renders on a live switch
 * (Settings language picker). Components call `const t = useT()`; non-component
 * code can call the bare `t()`. String tables are split by feature
 * (i18n/common, i18n/views, i18n/chat) so they can be edited independently.
 */
import { useMemo } from "react";
import { useSyncExternalStore } from "react";
import { common } from "./i18n/common";
import { views } from "./i18n/views";
import { chat } from "./i18n/chat";

export type Locale = "en" | "zh-CN";

export const LOCALE_STORAGE_KEY = "seekforge.locale";

type Table = { en: Record<string, string>; zh: Record<string, string> };
const TABLES: Table[] = [common, views, chat];
const EN: Record<string, string> = Object.assign({}, ...TABLES.map((t) => t.en));
const ZH: Record<string, string> = Object.assign({}, ...TABLES.map((t) => t.zh));
const STRINGS: Record<Locale, Record<string, string>> = { en: EN, "zh-CN": ZH };

/** Resolve a starting locale: stored choice > browser language ("zh*" → zh-CN) > en. */
export function detectLocale(stored?: string | null): Locale {
  if (stored === "en" || stored === "zh-CN") return stored;
  const nav =
    typeof navigator !== "undefined" && navigator.language ? navigator.language.toLowerCase() : "";
  return nav.startsWith("zh") ? "zh-CN" : "en";
}

let current: Locale = detectLocale(
  typeof localStorage !== "undefined" ? localStorage.getItem(LOCALE_STORAGE_KEY) : null,
);

const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

/** Switch locale, persist it, and notify subscribers (triggers re-render). */
export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  if (typeof localStorage !== "undefined") localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  if (typeof document !== "undefined") document.documentElement.setAttribute("lang", locale);
  for (const fn of listeners) fn();
}

function interpolate(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  let out = s;
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}

function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const s = STRINGS[locale][key] ?? STRINGS.en[key] ?? key;
  return interpolate(s, vars);
}

/** Bare translator for non-component code (uses the current locale). */
export function t(key: string, vars?: Record<string, string | number>): string {
  return translate(current, key, vars);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Subscribe a component to the active locale (re-renders on change). */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}

/** Returns a `t` bound to the active locale; the component re-renders on switch. */
export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  const locale = useLocale();
  return useMemo(
    () => (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale],
  );
}

/** Apply the persisted locale's <html lang> early (called from the app entry). */
export function initLocale(): void {
  if (typeof document !== "undefined") document.documentElement.setAttribute("lang", current);
}
