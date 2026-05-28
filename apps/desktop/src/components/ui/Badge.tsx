import type { HTMLAttributes } from "react";

export type BadgeTone = "neutral" | "accent" | "ok" | "warn" | "danger";

const TONE: Record<BadgeTone, string> = {
  neutral: "bg-surface-overlay text-secondary",
  accent: "bg-accent-muted text-accent-hover",
  ok: "bg-ok/15 text-ok",
  warn: "bg-warn/15 text-warn",
  danger: "bg-danger/15 text-danger",
};

type Props = HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone };

/** Tiny mono label chip (statuses, permission levels, counts). */
export function Badge({ tone = "neutral", className = "", ...rest }: Props) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-2xs uppercase tracking-wide ${TONE[tone]} ${className}`}
      {...rest}
    />
  );
}
