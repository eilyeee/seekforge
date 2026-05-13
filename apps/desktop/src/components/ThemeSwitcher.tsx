import { useEffect, useState } from "react";
import { Button } from "./ui";
import {
  dataThemeAttr,
  nextThemeChoice,
  readThemeChoice,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemeChoice,
} from "../lib/theme";

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Paint a resolved theme onto <html> (dark = no attribute, the default). */
function applyTheme(choice: ThemeChoice): void {
  if (typeof document === "undefined") return;
  const attr = dataThemeAttr(resolveTheme(choice, systemPrefersDark()));
  if (attr) document.documentElement.setAttribute("data-theme", attr);
  else document.documentElement.removeAttribute("data-theme");
}

/**
 * Applies the persisted theme as early as possible (called from the app entry
 * before render so there's no flash of the wrong palette). Safe to call once.
 */
export function initTheme(): void {
  if (typeof localStorage === "undefined") return;
  applyTheme(readThemeChoice(localStorage.getItem(THEME_STORAGE_KEY)));
}

const LABEL: Record<ThemeChoice, string> = {
  dark: "Dark",
  light: "Light",
  system: "System",
};

const GLYPH: Record<ThemeChoice, string> = {
  dark: "🌙",
  light: "☀",
  system: "🖥",
};

/**
 * Cycles dark -> light -> system. Persists to localStorage and re-paints
 * <html>; while on "system" it tracks the OS preference live.
 */
export function ThemeSwitcher({ className = "" }: { className?: string }) {
  const [choice, setChoice] = useState<ThemeChoice>(() =>
    typeof localStorage === "undefined" ? "system" : readThemeChoice(localStorage.getItem(THEME_STORAGE_KEY)),
  );

  // Apply on mount and whenever the choice changes.
  useEffect(() => {
    applyTheme(choice);
    if (typeof localStorage !== "undefined") localStorage.setItem(THEME_STORAGE_KEY, choice);
  }, [choice]);

  // While on "system", follow live OS changes.
  useEffect(() => {
    if (choice !== "system" || typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [choice]);

  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => setChoice((c) => nextThemeChoice(c))}
      title={`Theme: ${LABEL[choice]} (click to change)`}
      aria-label={`Theme: ${LABEL[choice]}`}
      className={className}
    >
      <span aria-hidden="true">{GLYPH[choice]}</span>
      {LABEL[choice]}
    </Button>
  );
}
