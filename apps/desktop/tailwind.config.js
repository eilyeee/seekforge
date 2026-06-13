/** @type {import('tailwindcss').Config} */

/**
 * SeekForge design tokens.
 *
 * Semantic colors are CSS variables (space-separated RGB, see index.css) so
 * Tailwind opacity modifiers like `bg-accent/20` keep working and a future
 * light theme only has to swap the variables.
 *
 * Vocabulary (use these in new code instead of raw zinc-*):
 *   bg-surface / bg-surface-raised / bg-surface-overlay
 *   border-subtle / border-strong          (borderColor shortcuts)
 *   text-primary / text-secondary / text-tertiary
 *   accent (whale blue), accent-hover, accent-muted (tinted bg)
 *   ok / warn / danger                     (status colors)
 */
const rgb = (v) => `rgb(var(${v}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: rgb("--sf-surface"),
          raised: rgb("--sf-surface-raised"),
          overlay: rgb("--sf-surface-overlay"),
        },
        accent: {
          DEFAULT: rgb("--sf-accent"),
          hover: rgb("--sf-accent-hover"),
          muted: rgb("--sf-accent-muted"),
        },
        ok: rgb("--sf-ok"),
        warn: rgb("--sf-warn"),
        danger: rgb("--sf-danger"),
      },
      textColor: {
        primary: rgb("--sf-text-primary"),
        secondary: rgb("--sf-text-secondary"),
        tertiary: rgb("--sf-text-tertiary"),
      },
      borderColor: {
        subtle: rgb("--sf-border-subtle"),
        strong: rgb("--sf-border-strong"),
      },
      ringColor: {
        DEFAULT: rgb("--sf-accent"),
      },
      ringOffsetColor: {
        DEFAULT: rgb("--sf-surface"),
      },
      borderRadius: {
        // Slightly more generous default radius (Claude-desktop-ish calm).
        DEFAULT: "0.375rem",
      },
      fontSize: {
        // One canonical micro size for captions/labels (replaces the scattered
        // text-[9px]/[10px]/[11px]); 11px keeps small chrome legible.
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      fontFamily: {
        // CJK-friendly system stacks (terminal-inspired UI, no webfonts).
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "PingFang SC",
          "Hiragino Sans GB",
          "Microsoft YaHei",
          "Noto Sans CJK SC",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "Sarasa Mono SC",
          "Noto Sans Mono CJK SC",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};
