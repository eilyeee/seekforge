import type { SVGProps } from "react";

/**
 * Inline 16px stroke icons (no icon-lib dependency). All inherit
 * `currentColor`; pass `size` to scale.
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Terminal prompt — Chat. */
export function IconChat(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 5l3 3-3 3" />
      <path d="M8.5 11H13" />
    </Svg>
  );
}

/** Stacked lines — Sessions. */
export function IconSessions(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 4h10" />
      <path d="M3 8h10" />
      <path d="M3 12h6" />
    </Svg>
  );
}

/** Plus / minus split — Diff. */
export function IconDiff(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 2.5v5" />
      <path d="M2.5 5h5" />
      <path d="M8.5 11h5" />
      <path d="M3 13.5L13 2.5" />
    </Svg>
  );
}

/** Four-point spark — Skills. */
export function IconSkills(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2l1.4 4.6L14 8l-4.6 1.4L8 14l-1.4-4.6L2 8l4.6-1.4z" />
    </Svg>
  );
}

/** Interlocking blocks — Plugins. */
export function IconPlugins(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <path d="M9 11.5h5M11.5 9v5" />
    </Svg>
  );
}

/** Branching arrows — Agents. */
export function IconAgents(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 13V7a4 4 0 014-4h6" />
      <path d="M10 .5L13 3l-3 2.5" />
      <path d="M3 13h10" />
      <path d="M10.5 10.5L13 13l-2.5 2.5" />
    </Svg>
  );
}

/** Layered DB — Memory. */
export function IconMemory(props: IconProps) {
  return (
    <Svg {...props}>
      <ellipse cx="8" cy="4" rx="5" ry="2" />
      <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" />
      <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
    </Svg>
  );
}

/** Circular arrows — Evolution. */
export function IconEvolution(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.5 8a5.5 5.5 0 11-1.6-3.9" />
      <path d="M13.5 1.5v3h-3" />
    </Svg>
  );
}

/** Sliders — Settings. */
export function IconSettings(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 5h7" />
      <path d="M12 5h2" />
      <circle cx="10.5" cy="5" r="1.5" />
      <path d="M2 11h2" />
      <path d="M7 11h7" />
      <circle cx="5.5" cy="11" r="1.5" />
    </Svg>
  );
}

/** Chevron pointing right (▸). Add `className="rotate-90"` for the open (▾) state. */
export function IconChevron(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 4l4 4-4 4" />
    </Svg>
  );
}

/** Six-line asterisk (✻) — thinking / reasoning. */
export function IconSparkle(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 3v10" />
      <path d="M3.7 5.5l8.6 5" />
      <path d="M12.3 5.5l-8.6 5" />
    </Svg>
  );
}

/** Lightbulb — thinking / reasoning effort. */
export function IconThinking(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5.6 9.4a4 4 0 1 1 4.8 0c-.6.5-1 1-1 1.7v.4h-2.8v-.4c0-.7-.4-1.2-1-1.7Z" />
      <path d="M6.2 13.3h3.6" />
      <path d="M6.9 15h2.2" />
    </Svg>
  );
}

/** Chip / CPU — the model picker. */
export function IconModel(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
      <path d="M6.5 2v2.5M9.5 2v2.5M6.5 11.5V14M9.5 11.5V14" />
      <path d="M2 6.5h2.5M2 9.5h2.5M11.5 6.5H14M11.5 9.5H14" />
    </Svg>
  );
}

/** Shield — the OS command sandbox. */
export function IconShield(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2l5 2v3.7c0 3-2 5.3-5 6.3-3-1-5-3.3-5-6.3V4l5-2Z" />
    </Svg>
  );
}

/** Down-then-right corner arrow (⤷) — a dispatched subagent. */
export function IconCornerDownRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 4v4a2 2 0 002 2h5" />
      <path d="M9 7l3 3-3 3" />
    </Svg>
  );
}

/** Rightward arrow (→) — hints, continuations. */
export function IconArrowRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 8h10" />
      <path d="M9 4l4 4-4 4" />
    </Svg>
  );
}

/** Folder — Files. */
export function IconFiles(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 4.5A1.5 1.5 0 013.5 3h2.6l1.4 1.6h5A1.5 1.5 0 0114 6.1v5.4A1.5 1.5 0 0112.5 13h-9A1.5 1.5 0 012 11.5z" />
    </Svg>
  );
}

/** Branch — Source Control. */
export function IconGit(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="4" cy="4" r="1.6" />
      <circle cx="4" cy="12" r="1.6" />
      <circle cx="12" cy="6" r="1.6" />
      <path d="M4 5.6v4.8" />
      <path d="M12 7.6c0 2-1.8 2.9-4 2.9" />
    </Svg>
  );
}

/** Magnifier — search / command palette. */
export function IconSearch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.5 3.5" />
    </Svg>
  );
}

/** SeekForge whale mark (filled, scales with `size`). */
export function LogoMark({ size = 20, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...rest}>
      {/* body */}
      <path
        d="M3 13.5c0-4.4 3.8-7.5 8.3-7.5 4 0 7.2 2.3 8.7 5.6.3.6-.1 1.2-.7 1.4-1.1.3-2.6 1-3.5 2.4-1 1.5-2.7 2.6-4.8 2.6H4.5c-.8 0-1.5-.7-1.5-1.5v-3z"
        fill="currentColor"
      />
      {/* tail */}
      <path d="M19.5 14.5l2.6-1.6c.5-.3 1.1.2.9.8l-1 3a.9.9 0 01-1.4.4l-1.1-1.1z" fill="currentColor" />
      {/* eye */}
      <circle cx="7.2" cy="12.2" r="1" fill="rgb(var(--sf-surface))" />
    </svg>
  );
}
