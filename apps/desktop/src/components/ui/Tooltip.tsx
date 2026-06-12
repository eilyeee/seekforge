import type { ReactNode } from "react";

type Props = {
  /** Tooltip text. */
  label: string;
  children: ReactNode;
  /** Where the bubble appears relative to the child. */
  side?: "top" | "bottom" | "right";
  className?: string;
};

const SIDE: Record<NonNullable<Props["side"]>, string> = {
  top: "bottom-full left-1/2 mb-1.5 -translate-x-1/2",
  bottom: "top-full left-1/2 mt-1.5 -translate-x-1/2",
  right: "left-full top-1/2 ml-1.5 -translate-y-1/2",
};

/** CSS-only hover tooltip (no portal, no JS): fine for short labels. */
export function Tooltip({ label, children, side = "top", className = "" }: Props) {
  return (
    <span className={`group/tip relative inline-flex ${className}`}>
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-50 whitespace-nowrap rounded-md border border-subtle bg-surface-overlay px-2 py-1 text-xs text-secondary opacity-0 shadow-lg shadow-black/40 transition-opacity delay-150 group-hover/tip:opacity-100 ${SIDE[side]}`}
      >
        {label}
      </span>
    </span>
  );
}
