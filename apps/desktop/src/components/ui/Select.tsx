import { useCallback, useEffect, useId, useRef, useState } from "react";
import { IconChevron } from "./icons";

export type SelectOption = {
  value: string;
  label: string;
  /** Optional secondary line shown under the label in the dropdown. */
  hint?: string;
};

type SelectProps = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** "sm" is the compact chip used in toolbars; "md" is the default form size. */
  size?: "sm" | "md";
  disabled?: boolean;
  /** Leading glyph/icon shown in the trigger (e.g. an emoji or small node). */
  leading?: React.ReactNode;
  /** Shown when no option matches `value`. */
  placeholder?: string;
  title?: string;
  ariaLabel?: string;
  /** Trigger width; defaults to auto. Toolbar chips usually leave this unset. */
  className?: string;
};

const TRIGGER_SIZE = {
  sm: "h-7 gap-1.5 px-2 text-xs",
  md: "h-9 gap-2 px-3 text-sm",
} as const;

/**
 * The one dropdown. A custom popover (not a native <select>) so it matches the
 * app's surface/border/accent tokens on every platform: rounded trigger with a
 * chevron, a floating panel with hover/active states, click-outside + Escape to
 * close, and basic keyboard selection. Used everywhere a choice is made.
 */
export function Select({
  value,
  options,
  onChange,
  size = "md",
  disabled,
  leading,
  placeholder,
  title,
  ariaLabel,
  className,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value);

  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const pick = (v: string) => {
    onChange(v);
    close();
  };

  return (
    <div ref={rootRef} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        disabled={disabled}
        title={title}
        aria-label={ariaLabel ?? title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`focus-ring inline-flex w-full items-center justify-between rounded-lg border border-strong bg-surface font-medium text-primary transition-colors hover:border-accent/60 disabled:cursor-not-allowed disabled:opacity-50 ${TRIGGER_SIZE[size]}`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {leading != null && <span className="shrink-0 text-tertiary">{leading}</span>}
          <span className={`truncate ${selected ? "" : "text-tertiary"}`}>
            {selected?.label ?? placeholder ?? ""}
          </span>
        </span>
        <IconChevron size={size === "sm" ? 12 : 14} className={`shrink-0 text-tertiary transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 z-50 mt-1 max-h-72 min-w-full overflow-auto rounded-lg border border-strong bg-surface-raised p-1 shadow-lg"
        >
          {options.map((o) => {
            const active = o.value === value;
            return (
              <li key={o.value} role="option" aria-selected={active}>
                <button
                  type="button"
                  onClick={() => pick(o.value)}
                  className={`flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                    active ? "bg-accent-muted text-accent" : "text-secondary hover:bg-surface-overlay hover:text-primary"
                  }`}
                >
                  <span className="truncate font-medium">{o.label}</span>
                  {o.hint && <span className="truncate text-2xs text-tertiary">{o.hint}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
